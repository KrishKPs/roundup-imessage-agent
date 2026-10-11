// The engine: every inbound text and timer tick comes through here. Pure logic, no Spectrum.
// Events run one at a time (a simple promise lock), so state never changes under our feet.
import type { Phraser } from "../llm/phrase.js";
import type { Understander } from "../llm/understand.js";
import type { TripExtractor } from "../llm/tripRequest.js";
import { type ConverseInput, type ConverseResult, type Converser, type Turn, replyIsGrounded } from "../llm/converse.js";
import { keywordParse } from "../llm/understand.js";
import { factAnswer, factsFor } from "./facts.js";
import type { ItineraryWriter } from "../llm/itinerary.js";
import { draftMessage, isMakeItinerary, isSendItinerary, itineraryFacts, parsePlace, sendItinerary, templateItinerary } from "./itinerary.js";
import { groupBudget } from "./plan.js";
import { titleFromAnything } from "./intents.js";
import type { Store } from "../store.js";
import type { Transport } from "../transport/transport.js";
import type { Ask, LogKind, Member, MessageIntent, Outbound, ParsedReply, Phone, Trip } from "../types.js";
import { clip, normalizePhone, parseName } from "../util.js";
import { template } from "../llm/phrase.js";
import { askIntent, enqueueAsk, itemLabel, resolvePending, sendNextQueued } from "./asks.js";
import { applyChainAnswer, newNeed, recomputeSeats, releaseCommitments, runChain } from "./chain.js";
import {
  type CommandEnv, type WebPerson, type WebTripInput, addPeople, announceJoins, markIn, newMember, setDate, createTrip, createWebTrip, greetWebSignup, handleCommand, joinWebTrip, optOut,
  sendTripCreated, welcome,
} from "./commands.js";
import { type Ctx, type EngineConfig, goingMembers, isGoing, organizerName, seatsNeed } from "./context.js";
import { finalize } from "./plan.js";
import { type SeedInput, buildDemoTrip } from "./seed.js";
import { announce, cleanNote, findPoll, isBareYesNo, isEitherOr, recordPollAnswer, resolveNames, startPoll } from "./poll.js";
import { checkSilence, restate } from "./timers.js";
import { finishInterview, interviewAnswer, maybeAskPrefs, prefCounts, readConstraints, readInterests } from "./prefs.js";

export interface EngineDeps {
  store: Store;
  transport: Transport;
  understand: Understander;
  phrase: Phraser;
  cfg: EngineConfig;
  now?: () => number;
  onChange?: () => void;
  /** Optional Gemini reader for free-text "let's plan X" messages. */
  extractTrip?: TripExtractor;
  /** Optional Gemini conversation layer for free text (questions, chat, plain-English organizer requests). */
  converse?: Converser;
  /** Optional model that drafts and edits the itinerary (falls back to a plain facts-only version). */
  writeItinerary?: ItineraryWriter;
  /** Dashboard animation hook: one call per private text in or out (Dashboard.md 4.2). Never gets message text. */
  onPulse?: (phone: Phone, direction: "in" | "out", topic: string | null) => void;
}

const HISTORY_KEEP = 12;

/** Replies that need no answer when we haven't asked anything. */
const ACK_ONLY = /^(ok|okay|k|kk|cool|sounds good|great|nice|thanks|thank you|thx|ty|got it|bet|perfect|awesome|alright|sure|👍|🙏|❤️|lol|haha)[!. ]*$/i;

const QUESTION_KINDS = new Set<MessageIntent["kind"]>([
  "ask_name_member", "ask_name_organizer", "ask_rsvp", "ask_budget", "ask_drive", "ask_seats", "ask_item", "reask", "nudge",
]);

export class Engine {
  private lock: Promise<void> = Promise.resolve();
  private lastSent = new Map<Phone, string>();
  private outbox: Outbound[] = [];
  readonly ctx: Ctx;

  constructor(private deps: EngineDeps) {
    const now = deps.now ?? Date.now;
    this.ctx = {
      now,
      cfg: deps.cfg,
      out: (phone, intent) => this.queueOut(phone, intent),
      log: (trip, kind, text) => this.log(trip, kind, text),
    };
  }

  get state() {
    return this.deps.store.state;
  }

  /** Entry point for every text a person sends us. */
  handleInbound(rawPhone: string, text: string): Promise<void> {
    return this.run(async () => {
      const phone = normalizePhone(rawPhone);
      const body = text.trim();
      if (!body) return;
      this.remember(phone, "them", body);
      this.count(phone, "texts");
      this.deps.onPulse?.(phone, "in", null);
      const trip = this.tripOf(phone);
      const m = trip?.members[phone];
      if (m?.optedOut) return; // stop is permanent: never reply again
      const firstContact = !!m?.invited && !m.heardFrom;
      const webFirst = !!m?.viaLink && !m.heardFrom;
      if (m) {
        m.sentSinceReply = 0;
        m.heardFrom = true;
      }
      if (trip && m && webFirst) {
        // Signed up on the website; this is their one-tap "hi" from the page.
        greetWebSignup(this.ctx, trip, m);
        this.advance(trip);
        return;
      }
      if (trip && m && firstContact && !m.pendingAsk && (ACK_ONLY.test(body) || /^(hi|hey|hello|yo|sup|hii+)\b/i.test(body))) {
        // Added by the organizer, and this is their first text (maybe our invite never arrived).
        this.ctx.out(phone, { kind: "invited", name: m.name, trip: trip.title, organizer: organizerName(trip), date: trip.dateText });
        if (!m.name) enqueueAsk(this.ctx, trip, m, "name");
        else {
          markIn(this.ctx, trip, m); // they texted us back: they're in
          if (trip.status !== "collecting_members" && m.budgetCap === null) enqueueAsk(this.ctx, trip, m, "budget");
        }
        this.advance(trip);
        return;
      }

      if (trip && m && phone === trip.organizer && (await this.itineraryCommand(trip, body))) {
        this.advance(trip);
        return;
      }

      const env: CommandEnv = { ctx: this.ctx, state: this.state, resetState: () => this.deps.store.reset() };
      if (handleCommand(env, phone, body)) {
        const t = this.tripOf(phone);
        if (t) this.advance(t);
        return;
      }
      if (!trip || !m) {
        await this.stranger(env, phone, body);
        return;
      }
      await this.handleReply(trip, m, body);
      sendNextQueued(this.ctx, trip, m); // release anything held while they were quiet
      this.advance(trip);
    }, normalizePhone(rawPhone));
  }

  /** The organizer shared contact cards in the chat: add and invite those people. */
  handleContacts(rawPhone: string, people: { name: string | null; phone: string }[]): Promise<void> {
    return this.run(async () => {
      const phone = normalizePhone(rawPhone);
      const env: CommandEnv = { ctx: this.ctx, state: this.state, resetState: () => this.deps.store.reset() };
      const m = this.tripOf(phone)?.members[phone];
      if (m?.optedOut) return;
      if (m) m.sentSinceReply = 0;
      addPeople(env, phone, people);
      const t = this.tripOf(phone);
      if (t) this.advance(t);
    });
  }

  /** Website "+": create a trip for the organizer. Returns its join code. */
  async createTripFromWeb(input: WebTripInput): Promise<string> {
    let code = "";
    await this.run(async () => {
      code = createWebTrip(this.env(), input).code;
    });
    return code;
  }

  /** Website trip link: sign a member up. Returns the trip title, or null if the code is unknown or they opted out. */
  async joinFromWeb(code: string, person: WebPerson): Promise<string | null> {
    let title: string | null = null;
    await this.run(async () => {
      title = joinWebTrip(this.env(), code, person)?.title ?? null;
    });
    return title;
  }

  // ---------------------------------------------------------------- itinerary

  /** Exact itinerary messages from the organizer. Returns true if handled. */
  private async itineraryCommand(trip: Trip, body: string): Promise<boolean> {
    const place = parsePlace(body);
    if (trip.awaitingPlace) {
      if (/^(skip|not sure|idk|tbd|no idea|doesn'?t matter|anywhere|undecided)\b/i.test(body)) {
        trip.awaitingPlace = false;
        await this.makeItinerary(trip, null);
        return true;
      }
      const reply = place ?? (body.split(/\s+/).length <= 6 && !body.includes("?") && !isSendItinerary(body) ? body.replace(/[.!]+$/, "") : null);
      if (reply) {
        await this.setPlace(trip, reply);
        return true;
      }
    }
    if (place) {
      await this.setPlace(trip, place);
      return true;
    }
    if (isMakeItinerary(body)) {
      await this.makeItinerary(trip, null);
      return true;
    }
    // plan.md F: a plain "yes" approves the draft (only when no other question is waiting on the organizer).
    const orgAsk = trip.members[trip.organizer]?.pendingAsk;
    const approve = /^(yes|yep|yeah|yup|ya|looks good|lgtm|perfect|approve|approved|love it|good to go|ship it)\b/i.test(body.trim());
    if (approve && trip.itinerary && trip.itinerary.text !== trip.itinerary.sentText && (!orgAsk || ["interview", "interest", "constraint"].includes(orgAsk.topic))) {
      sendItinerary(this.ctx, trip, this.ctx.cfg.tripLink?.(trip.code) ?? null);
      return true;
    }
    if (isSendItinerary(body) && trip.itinerary) {
      sendItinerary(this.ctx, trip, this.ctx.cfg.tripLink?.(trip.code) ?? null);
      return true;
    }
    return false;
  }

  private async setPlace(trip: Trip, place: string): Promise<void> {
    const waiting = trip.awaitingPlace;
    trip.place = place.slice(0, 60);
    trip.awaitingPlace = false;
    this.log(trip, "answered", `${trip.title} is at ${trip.place}`);
    if (waiting || trip.itinerary) return this.makeItinerary(trip, trip.itinerary ? `the place is now ${trip.place}` : null);
    this.ctx.out(trip.organizer, { kind: "text", text: `got it, ${trip.title} is at ${trip.place}. text "make the itinerary" whenever you want a plan for the day.` });
  }

  /** Draft (change = null) or edit the itinerary, then show it to the organizer. */
  private async makeItinerary(trip: Trip, change: string | null): Promise<void> {
    const ctx = this.ctx;
    if (!change && !trip.place && !trip.awaitingPlace && !trip.itinerary) {
      trip.awaitingPlace = true;
      ctx.out(trip.organizer, { kind: "text", text: "on it! where are you all headed?" });
      return;
    }
    trip.awaitingPlace = false;
    const input = {
      facts: itineraryFacts(trip), draft: change ? trip.itinerary?.text ?? null : null, change,
      names: Object.values(trip.members).map((x) => x.name).filter(Boolean), budget: groupBudget(trip),
    };
    const written = this.deps.writeItinerary ? await this.deps.writeItinerary(input) : null;
    const text = written ?? (change ? null : templateItinerary(trip));
    if (!text) {
      ctx.out(trip.organizer, { kind: "text", text: "sorry, i couldn't make that change. mind saying it another way?" });
      return;
    }
    trip.itinerary = { text, updatedAt: ctx.now(), sentAt: trip.itinerary?.sentAt ?? null };
    // An edit that moves the day/time ("push it an hour later") moves the trip too, so everyone's own plan agrees.
    const when = text.split("\n")[0].split(" · ")[1]?.trim();
    if (change && when && when.length <= 40 && when.toLowerCase() !== trip.dateText?.toLowerCase()) trip.dateText = when.toLowerCase();
    this.log(trip, "answered", change ? "itinerary updated" : "itinerary drafted");
    ctx.out(trip.organizer, { kind: "text", text: draftMessage(text, !!change) });
  }

  private prefetched: Promise<ConverseResult | null> | null = null;

  private converseInput(trip: Trip, m: Member, text: string): ConverseInput {
    return {
      role: m.phone === trip.organizer ? "organizer" : "member", name: m.name, text,
      facts: factsFor(trip, m, this.ctx), history: this.historyOf(m.phone).slice(-9, -1),
    };
  }

  private count(phone: Phone, what: "texts" | "questions"): void {
    const trip = this.tripOf(phone);
    if (!trip) return;
    trip.counters ??= { texts: 0, questions: 0 };
    trip.counters[what] += 1;
  }

  private historyOf(phone: Phone): Turn[] {
    return this.state.history?.[phone] ?? [];
  }

  private remember(phone: Phone, from: Turn["from"], text: string): void {
    const all = (this.state.history ??= {});
    const list = (all[phone] ??= []);
    list.push({ from, text, at: this.ctx.now() });
    if (list.length > HISTORY_KEEP) list.splice(0, list.length - HISTORY_KEEP);
  }

  /**
   * Free text that isn't a clean answer or command: let Gemini read it with the trip facts and pick an action.
   * Code runs the action; Gemini's own words are only used when they add no numbers beyond the facts.
   * Returns false when there's no AI or it failed, so the caller's fixed reply is used instead.
   */
  private async talk(trip: Trip, m: Member, text: string): Promise<boolean> {
    if (!this.deps.converse) return false;
    const ctx = this.ctx;
    const isOrganizer = m.phone === trip.organizer;
    const input = this.converseInput(trip, m, text);
    const facts = input.facts;
    const res = await (this.prefetched ?? this.deps.converse(input));
    this.prefetched = null;
    if (!res) return false;
    const env = this.env();
    const reply = res.reply && replyIsGrounded(res.reply, facts, text) ? res.reply : null;
    if (isOrganizer) {
      switch (res.action) {
        case "ask_everyone":
          if (!res.question) break;
          startPoll(ctx, trip, `${res.question.trim().replace(/[?!.\s]+$/, "")}?`, resolveNames(trip, res.to));
          return true;
        case "tell_everyone":
          if (!res.message) break;
          announce(ctx, trip, cleanNote(res.message), resolveNames(trip, res.to));
          return true;
        case "make_itinerary":
          await this.makeItinerary(trip, null);
          return true;
        case "edit_itinerary":
          if (!res.change || !trip.itinerary) break;
          await this.makeItinerary(trip, res.change);
          return true;
        case "send_itinerary":
          if (!trip.itinerary) break;
          sendItinerary(ctx, trip, ctx.cfg.tripLink?.(trip.code) ?? null);
          return true;
        case "set_place":
          if (!res.place) break;
          await this.setPlace(trip, res.place.trim());
          return true;
        case "status": return handleCommand(env, m.phone, "status");
        case "start": return handleCommand(env, m.phone, "start");
        case "send_plans": return handleCommand(env, m.phone, "plan");
        case "add_items":
          if (!res.items?.length) break;
          return handleCommand(env, m.phone, `need ${res.items.join(", ")}`);
        case "set_date":
          if (!res.date) break;
          setDate(ctx, trip, res.date.trim());
          return true;
      }
    } else if (res.action === "pass_to_organizer" || res.action === "tell_organizer") {
      // Only the organizer gets a short summary, and only after the member is told it's being passed on (spec 10.2).
      const fyi = res.action === "tell_organizer";
      const org = organizerName(trip);
      ctx.out(m.phone, { kind: "text", text: reply ?? (fyi ? `got it, i'll let ${org} know.` : `good question, i'll check with ${org} and get back to you.`) });
      ctx.out(trip.organizer, { kind: "question_organizer", name: m.name || "someone", note: safeNote(res.note, m, facts, text), fyi });
      const note = safeNote(res.note, m, facts, text);
      if (fyi && note) (trip.notes ??= []).push({ name: m.name || "someone", note, at: ctx.now() });
      ctx.log(trip, "handoff", `passed ${m.name || "someone"}'s ${fyi ? "note" : "question"} to ${org}`);
      return true;
    }
    if (!reply) return false;
    ctx.out(m.phone, { kind: "text", text: reply });
    // Keep the conversation on track: repeat the open question unless the reply already asks something.
    // (Optional planning questions just wait: no nagging after small talk.)
    if (m.pendingAsk && !reply.includes("?") && !["interview", "interest", "constraint"].includes(m.pendingAsk.topic)) {
      ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
    }
    return true;
  }

  private env(): CommandEnv {
    return { ctx: this.ctx, state: this.state, resetState: () => this.deps.store.reset() };
  }

  /** Called every 15 seconds: nudges, give-ups, and time-based progress. */
  tick(): Promise<void> {
    return this.run(async () => {
      for (const trip of Object.values(this.state.trips)) {
        // People who texted in before "joining = in" existed are in too (no pending question means nothing in flight).
        for (const m of Object.values(trip.members)) {
          if (m.heardFrom && m.name && m.rsvp === "unknown" && !m.pendingAsk && m.phone !== trip.organizer) markIn(this.ctx, trip, m);
        }
        announceJoins(this.ctx, trip);
        // plan.md C/E trigger: setup done and at least half of the people going said what they're into -> first draft.
        const c = prefCounts(trip);
        if (trip.prefs?.interviewDone && !trip.itinerary && !trip.awaitingPlace && trip.status !== "collecting_members"
            && c.going > 0 && c.answered * 2 >= c.going) await this.makeItinerary(trip, null);
        if (trip.status === "collecting_members") {
          checkSilence(this.ctx, trip); // name questions can still go stale
          continue;
        }
        checkSilence(this.ctx, trip);
        this.advance(trip);
      }
    });
  }

  /** DEMO_MODE: wipe everything and build the demo trip (spec 14). */
  seedDemo(input: SeedInput): Promise<void> {
    return this.run(async () => {
      this.deps.store.reset();
      const trip = buildDemoTrip(this.ctx, input);
      this.state.trips[trip.id] = trip;
      for (const phone of Object.keys(trip.members)) this.state.phoneTrip[phone] = trip.id;
      this.advance(trip);
    });
  }

  // ---------------------------------------------------------------- demo bar (Dashboard.md 10-11)

  private latestTrip(): Trip | undefined {
    return Object.values(this.state.trips).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Add simulated, labeled crowd members ("sim:N") to the newest trip. They're never texted for real. */
  addCrowd(names: string[], drives: (phone: Phone) => boolean): Promise<void> {
    return this.run(async () => {
      const trip = this.latestTrip();
      if (!trip) throw new Error("seed or create a trip first");
      const now = this.ctx.now();
      let n = Object.keys(trip.members).filter((p) => p.startsWith("sim:")).length;
      names.forEach((name, i) => {
        let phone = `sim:${++n}`;
        while (trip.members[phone]) phone = `sim:${++n}`;
        const m = newMember(phone, name, now + i);
        m.sim = true;
        m.heardFrom = true;
        m.simDrives = drives(phone);
        trip.members[phone] = m;
        this.state.phoneTrip[phone] = trip.id;
        this.log(trip, "joined", `${name} joined (sim)`);
        if (trip.status !== "collecting_members") enqueueAsk(this.ctx, trip, m, "rsvp");
      });
      this.advance(trip);
    });
  }

  /** The organizer texting "start", from the demo bar. */
  async demoStart(): Promise<void> {
    const trip = this.latestTrip();
    if (trip) await this.handleInbound(trip.organizer, "start");
  }

  /** A driver drops out on cue (a simulated one if possible), to show the rebalance. */
  async demoDrop(): Promise<string | null> {
    const trip = this.latestTrip();
    if (!trip) return null;
    const seats = seatsNeed(trip);
    const going = Object.values(trip.members).filter((m) => isGoing(m) && m.phone !== trip.organizer);
    const pick = going.find((m) => m.sim && seats?.providers.includes(m.phone)) ?? going.find((m) => m.sim) ?? null;
    if (!pick) return null;
    await this.handleInbound(pick.phone, "something came up, i can't come anymore sorry");
    return pick.name;
  }

  /** DEMO_MODE: wipe everything. */
  reset(): Promise<void> {
    return this.run(async () => this.deps.store.reset());
  }

  /**
   * Someone not in any trip, whose message the keyword rules couldn't place.
   * Gemini gets a look first; otherwise we ask what they're planning and take their next reply as the title.
   */
  private async stranger(env: CommandEnv, phone: Phone, body: string): Promise<void> {
    const awaiting = (this.state.awaitingPlan ??= {});
    const fromLlm = this.deps.extractTrip ? await this.deps.extractTrip(body) : null;
    if (fromLlm) return createTrip(env, phone, fromLlm.title, fromLlm.dateText);
    if (this.ctx.cfg.quietToStrangers) return; // probably a personal text to this Mac's account: stay out of it
    if (awaiting[phone] && !/^(hi|hey|hello|yo|sup|hii+|hey there)[!.\s]*$/i.test(body)) {
      const req = titleFromAnything(body);
      return createTrip(env, phone, req.title, req.dateText);
    }
    awaiting[phone] = this.ctx.now();
    this.ctx.out(phone, { kind: "ask_what_planning" });
  }

  // ---------------------------------------------------------------- replies

  private async handleReply(trip: Trip, m: Member, text: string): Promise<void> {
    const ctx = this.ctx;
    const ask: Ask | null = m.pendingAsk ?? m.staleAsk;
    const isStale = !m.pendingAsk && !!m.staleAsk;

    // "yeah as long as we're back by 8" at any point: the organizer hears the catch; the open question stays open.
    if (m.phone !== trip.organizer && ask?.topic !== "rsvp" && ask?.topic !== "poll" && isGoing(m)) {
      const condition = keywordParse(text, "rsvp").rsvp === "yes" ? rsvpCondition(text) : null;
      if (condition) {
        (trip.notes ??= []).push({ name: m.name || "someone", note: condition, at: ctx.now() });
        ctx.out(trip.organizer, { kind: "question_organizer", name: m.name || "someone", note: condition, fyi: true });
        ctx.out(m.phone, { kind: "text", text: `noted, i'll flag that to ${organizerName(trip)}` });
        if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
        return;
      }
    }

    // Setup interview (organizer) and preference questions (members): read in code, one at a time.
    // A question or a request ("does 10am work for everyone?", "ask sam...") isn't a setup answer: normal path.
    const request = /\?\s*$/.test(text) || /\binstead\b/i.test(text)
      || /^(ask|tell|remind|let'?s?|can (you|u)|could (you|u)|check|pls|please|move|push|change|switch|actually|we need|need|start|status|send|make|figure|who|what|how|does|do|is|are|cancel|add)\b/i.test(text.trim());
    if (ask && !isStale && ask.topic === "interview" && ask.step && !request) {
      const r = interviewAnswer(trip, ask.step, text);
      if (r === "done") return finishInterview(ctx, trip);
      if (r === "next") {
        resolvePending(ctx, trip, m); // sends the next setup question, if any
        const more = m.pendingAsk?.topic === "interview" || m.askQueue.some((a) => a.topic === "interview");
        if (!more) finishInterview(ctx, trip);
        return;
      }
      // "other": not an answer to the setup question; handled below like any message (the question stays open).
    }
    if (ask && !isStale && (ask.topic === "interest" || ask.topic === "constraint")
        && !/\?\s*$/.test(text) && keywordParse(text, null).intent !== "drop") {
      const got = ask.topic === "interest" ? readInterests(text) : readConstraints(text);
      m.prefs = { ...m.prefs, ...got };
      const none = ask.topic === "interest" ? !got.interests?.length : !got.constraints?.length;
      const acks = ask.topic === "interest" ? ["love that, noted", "nice, i'll work that in", "good to know"] : ["got it, i'll plan around that", "noted, that stays with me", "good to know, i'll plan around it"];
      ctx.out(m.phone, { kind: "text", text: none ? "all good" : acks[m.phone.length % acks.length] });
      ctx.log(trip, "answered", ask.topic === "interest" ? `${m.name} said what they're into` : `${m.name} answered the plan-around question`);
      resolvePending(ctx, trip, m);
      return;
    }

    if (ask?.topic === "name") {
      const name = parseName(text);
      if (!name && text.includes("?")) return this.answerQuestion(trip, m, text);
      if (!name) return this.unclear(trip, m, ask);
      m.name = name;
      resolvePending(ctx, trip, m);
      if (m.phone === trip.organizer) sendTripCreated(ctx, trip);
      else welcome(ctx, trip, m);
      return;
    }

    // "what time are we leaving" (with or without a "?"): answered from the organizer's own details when we have them.
    const fromFacts = m.phone === trip.organizer ? null : factAnswer(trip, text);
    if (fromFacts) {
      ctx.out(m.phone, { kind: "text", text: fromFacts });
      if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
      return;
    }

    // An open question from the organizer ("which days are you free?"): their words are the answer.
    if (ask?.topic === "poll" && findPoll(trip, ask.pollId) && !/\?\s*$/.test(text)
        && !/\b(can'?t (come|make it) anymore|not (coming|going) anymore|i'?m out\b|drop(ping)? out|have to bail|gotta bail)/i.test(text)) {
      // "yes" to "wednesday or the weekend?" says nothing: ask which one, once, instead of reporting a useless yes.
      const question = findPoll(trip, ask.pollId)!.question;
      if (!isStale && !ask.clarified && isEitherOr(question) && isBareYesNo(text)) {
        ask.clarified = true;
        ctx.out(m.phone, { kind: "text", text: `ha which one? ${question}` });
        return;
      }
      recordPollAnswer(this.ctx, trip, m, ask, text);
      if (!isStale) resolvePending(this.ctx, trip, m);
      else m.staleAsk = null;
      return;
    }

    // If the keywords can't read this, the model will be needed; start the conversation call now, in parallel.
    this.prefetched = this.deps.converse && keywordParse(text, ask?.topic ?? null).confidence < 0.85
      ? this.deps.converse(this.converseInput(trip, m, text))
      : null;
    const parsed = await this.deps.understand(text, ask?.topic ?? null, this.historyOf(m.phone).slice(-5, -1));

    if (parsed.intent === "opt_out") {
      optOut(ctx, trip, m);
      return;
    }
    if (parsed.intent === "drop" && m.rsvp !== "no") return this.dropout(trip, m);
    if (parsed.intent === "question") return this.answerQuestion(trip, m, text);
    if (!ask && ACK_ONLY.test(text.trim())) return; // "ok", "sounds good": nothing to say back
    if (!ask) return this.unprompted(trip, m, parsed, text);

    if (parsed.confidence < 0.6 || !answers(ask, parsed)) {
      if (isStale) return this.unprompted(trip, m, parsed, text);
      // Not an answer, but maybe something else entirely ("fyi i'm allergic to peanuts", "push it an hour later"):
      // let the conversation layer handle that first; it repeats the open question afterwards.
      if (parsed.intent !== "answer" && (await this.talk(trip, m, text))) return;
      return this.unclear(trip, m, ask);
    }
    if (isStale) m.staleAsk = null;
    this.applyAnswer(trip, m, ask, parsed, isStale, text);
  }

  private applyAnswer(trip: Trip, m: Member, ask: Ask, parsed: ParsedReply, isStale: boolean, text = ""): void {
    const ctx = this.ctx;
    const close = () => (isStale ? undefined : resolvePending(ctx, trip, m));

    if (ask.topic === "rsvp") {
      m.rsvp = parsed.rsvp!;
      if (parsed.canDrive) {
        m.carHint = true;
        if (parsed.seats) m.seats = parsed.seats;
      }
      if (parsed.canDrive === false) m.carHint = false;
      const condition = m.rsvp !== "no" ? rsvpCondition(text) : null;
      if (condition) {
        // "yeah as long as we're back by 8": they're in, and the organizer should know the catch.
        (trip.notes ??= []).push({ name: m.name || "someone", note: condition, at: ctx.now() });
        if (m.phone !== trip.organizer) ctx.out(trip.organizer, { kind: "question_organizer", name: m.name || "someone", note: condition, fyi: true });
        ctx.out(m.phone, { kind: "text", text: `noted, i'll flag that to ${organizerName(trip)}` });
      } else ctx.out(m.phone, { kind: "ack", topic: "rsvp", value: parsed.rsvp! });
      ctx.log(trip, "answered", m.rsvp === "yes" ? `${m.name} is in` : m.rsvp === "maybe" ? `${m.name} is a maybe` : `${m.name} can't make it`);
      close();
      if (isGoing(m) && m.budgetCap === null) enqueueAsk(ctx, trip, m, "budget");
      if (!isGoing(m)) releaseCommitments(ctx, trip, m);
      return;
    }

    if (ask.topic === "poll") {
      const value: string = parsed.rsvp ?? (parsed.itemYes === null ? "maybe" : parsed.itemYes ? "yes" : "no");
      recordPollAnswer(ctx, trip, m, ask, value); // thank them before any next question
      close();
      return;
    }

    if (ask.topic === "budget") {
      m.budgetCap = parsed.budgetCap;
      ctx.out(m.phone, { kind: "ack", topic: "budget", value: parsed.budgetCap === null ? "skip" : "done" });
      ctx.log(trip, "answered", parsed.budgetCap === null ? `${m.name} skipped the budget question` : `${m.name} shared a budget privately`);
      close();
      return;
    }

    // drive / seats / item: belongs to a need's chain
    const need = trip.needs.find((n) => n.id === ask.needId);
    if (!need) return close();
    const result = applyChainAnswer(ctx, trip, need, m, parsed);
    if (result === "need_seat_count") {
      close();
      enqueueAsk(ctx, trip, m, "seats", need.id);
      return;
    }
    if (result === "backup") {
      ctx.out(m.phone, { kind: "text", text: "got it, you're my backup. i'll try others first" });
      close();
      return;
    }
    if (result === "ignored") ctx.out(m.phone, { kind: "late_ack" });
    else ctx.out(m.phone, { kind: "ack", topic: ask.topic, value: result === "provided" ? "yes" : "no" });
    close();
  }

  /** Confidence too low: re-ask once more simply, then hand off to the organizer (spec 8). */
  private unclear(trip: Trip, m: Member, ask: Ask): void {
    const ctx = this.ctx;
    m.unclearCount += 1;
    if (m.unclearCount < 2) {
      ctx.out(m.phone, { kind: "reask", topic: ask.topic, item: itemLabel(trip, ask), question: restate(trip, ask) });
      return;
    }
    const org = organizerName(trip);
    ctx.out(m.phone, { kind: "handoff_member", organizer: org });
    if (m.phone !== trip.organizer) {
      ctx.out(trip.organizer, { kind: "handoff_organizer", name: m.name || "a new member", topic: ask.topic, item: itemLabel(trip, ask) });
    }
    ctx.log(trip, "handoff", `handed ${m.name || "a new member"} to ${org}`);
    const need = trip.needs.find((n) => n.id === ask.needId);
    if (need) {
      if (!need.declined.includes(m.phone)) need.declined.push(m.phone);
      if (need.waitingOn === m.phone) need.waitingOn = null;
    }
    resolvePending(ctx, trip, m);
  }

  /** "i can't come anymore" (spec 9.5). */
  private dropout(trip: Trip, m: Member): void {
    const ctx = this.ctx;
    m.droppedOut = true;
    m.rsvp = "no";
    m.pendingAsk = null;
    m.askQueue = [];
    m.staleAsk = null;
    releaseCommitments(ctx, trip, m);
    ctx.out(m.phone, { kind: "drop_ack", name: m.name });
    ctx.log(trip, "dropped", `${m.name} can't come anymore`);
    if (m.phone !== trip.organizer) ctx.out(trip.organizer, { kind: "organizer_drop", name: m.name });
  }

  /** Answer only from trip facts; anything else goes to the organizer. Then repeat the open question. */
  private async answerQuestion(trip: Trip, m: Member, text: string): Promise<void> {
    const ctx = this.ctx;
    const fromFacts = m.phone === trip.organizer ? null : factAnswer(trip, text);
    if (fromFacts) {
      ctx.out(m.phone, { kind: "text", text: fromFacts });
      if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
      return;
    }
    if (await this.talk(trip, m, text)) return;
    if (m.phone === trip.organizer && this.deps.converse) {
      ctx.out(m.phone, { kind: "text", text: "sorry, i blanked on that one. mind sending it again?" });
      return;
    }
    if (m.phone === trip.organizer) {
      // The organizer isn't asking us about their own trip; show them what we can do for them.
      ctx.out(m.phone, { kind: "organizer_help" });
      if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
      return;
    }
    // "what's the plan?", "when is it?", "who's going?" are answered from trip facts. Anything else goes to the organizer.
    const basic = /\b(plan|what('?s| is) (this|up|happening|going on)|when|what day|date|who|organi[sz]|trip|happening)\b/i.test(text);
    const flagged = !basic && m.phone !== trip.organizer;
    ctx.out(m.phone, {
      kind: "question_answer", trip: trip.title, date: trip.dateText, organizer: organizerName(trip),
      collecting: trip.status === "collecting_members", flagged,
    });
    if (flagged) ctx.out(trip.organizer, { kind: "question_organizer", name: m.name || "someone" });
    if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
  }

  /** A message when no question is open: changed answers ("actually i can drive") or chit-chat. */
  private async unprompted(trip: Trip, m: Member, parsed: ParsedReply, text: string): Promise<void> {
    const ctx = this.ctx;
    const seats = seatsNeed(trip);
    const rename = text.trim().match(/^(?:my name is|my name'?s|call me|actually it'?s|it'?s actually|actually my name is|no,? it'?s)\s+(\p{L}+)/iu);
    const newName = rename ? parseName(rename[1]) : null;
    if (newName) {
      m.name = newName;
      ctx.out(m.phone, { kind: "text", text: `got it, ${newName}!` });
      return;
    }
    if (parsed.canDrive === true) {
      m.carHint = true;
      m.canDrive = null; // let the chain ask them properly
      if (seats) {
        seats.declined = seats.declined.filter((p) => p !== m.phone);
        if (!seats.providers.includes(m.phone)) seats.asked = seats.asked.filter((p) => p !== m.phone);
      }
      ctx.out(m.phone, { kind: "noted_car" });
      return;
    }
    if (parsed.canDrive === false) {
      m.carHint = false;
      m.canDrive = false;
      const released = releaseCommitments(ctx, trip, m, "seats");
      ctx.out(m.phone, { kind: "ack", topic: "drive", value: "no" });
      if (released.length) {
        ctx.log(trip, "dropped", `${m.name} can't drive anymore`);
        if (m.phone !== trip.organizer) ctx.out(trip.organizer, { kind: "text", text: `heads up: ${m.name} can't drive anymore. i'm finding another car.` });
      }
      return;
    }
    if (parsed.rsvp === "yes" && m.rsvp === "no") {
      m.rsvp = "yes";
      ctx.out(m.phone, { kind: "ack", topic: "rsvp", value: "yes" });
      ctx.log(trip, "answered", `${m.name} is back in`);
      if (m.budgetCap === null) enqueueAsk(ctx, trip, m, "budget");
      return;
    }
    if (await this.talk(trip, m, text)) return;
    if (m.phone === trip.organizer && this.deps.converse) return ctx.out(m.phone, { kind: "text", text: "sorry, i blanked on that one. mind sending it again?" });
    if (m.phone === trip.organizer) return ctx.out(m.phone, { kind: "organizer_help" });
    ctx.out(m.phone, trip.status === "collecting_members"
      ? { kind: "waiting_for_start", organizer: organizerName(trip) }
      : { kind: "all_set" });
  }

  /** Resolves once every queued event has finished (used for a clean shutdown). */
  idle(): Promise<void> {
    return this.lock;
  }

  // ---------------------------------------------------------------- progress

  /** Move the trip forward: open the seats chain, run chains in order, finalize when everything settles. */
  private advance(trip: Trip): void {
    if (trip.status === "collecting_members") return;
    const ctx = this.ctx;
    const named = Object.values(trip.members).filter((m) => m.name && !m.optedOut);

    const answered = named.filter((m) => m.rsvp !== "unknown").length;
    const timedOut = trip.startedAt !== null && ctx.now() - trip.startedAt >= ctx.cfg.nudgeAfterMs;
    const ready = answered === named.length || (answered * 2 >= named.length && timedOut);
    const ridesOn = trip.settings?.rides !== false; // old trips: on

    let seats = ridesOn ? seatsNeed(trip) : undefined;
    if (ridesOn && !seats && ready) {
      seats = newNeed("seats", "seats", 0);
      trip.needs.unshift(seats);
    }
    if (ridesOn && !seats) return;
    if (!ridesOn && !ready && !trip.needs.some((n) => n.asked.length)) return; // rides off: items start when RSVPs settle

    if (seats) {
      recomputeSeats(trip);
      runChain(ctx, trip, seats);
    }
    if (!seats || seats.status !== "open") {
      for (const need of trip.needs) {
        if (need.kind !== "item") continue;
        runChain(ctx, trip, need);
        if (need.status === "open") break; // item chains run one at a time
      }
    }

    const done = trip.needs.every((n) => n.status !== "open");
    // Rides and items are sorted: now everyone who's in gets the two preference questions (once each).
    if (done) for (const m of goingMembers(trip)) if (!m.pendingAsk) maybeAskPrefs(ctx, trip, m);
    // Optional planning questions (preferences, setup interview) never hold up the logistics plans.
    const optional = (a: { topic: string } | null) => !!a && ["interest", "constraint", "interview"].includes(a.topic);
    const settled = Object.values(trip.members).every(
      (m) => m.optedOut || ((!m.pendingAsk || optional(m.pendingAsk)) && (m.askQueue.every(optional) || m.sentSinceReply >= 2)),
    );
    if (done && settled) finalize(ctx, trip);
    else if (!done && trip.status === "finalized") trip.status = "coordinating";
  }

  // ---------------------------------------------------------------- plumbing

  private tripOf(phone: Phone): Trip | undefined {
    const id = this.state.phoneTrip[phone];
    return id ? this.state.trips[id] : undefined;
  }

  private queueOut(phone: Phone, intent: MessageIntent): void {
    const m = this.tripOf(phone)?.members[phone];
    if (m?.optedOut && intent.kind !== "stop_confirm") return;
    if (m && QUESTION_KINDS.has(intent.kind)) {
      m.sentSinceReply += 1;
      this.count(phone, "questions");
    }
    this.outbox.push({ phone, intent });
  }

  private log(trip: Trip, kind: LogKind, text: string): void {
    trip.log.push({ at: this.ctx.now(), kind, text });
    if (trip.log.length > 200) trip.log.splice(0, trip.log.length - 200);
  }

  private run(fn: () => Promise<void>, sender?: Phone): Promise<void> {
    const next = this.lock.then(async () => {
      try {
        await fn();
      } catch (err) {
        console.error("[engine] error while handling event:", err);
      }
      this.deps.store.save();
      this.deps.onChange?.();
      const out = this.outbox;
      this.outbox = [];
      await this.flush(out, sender);
    });
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Phrase and send. An ack followed by a question to the same person is merged into one text. */
  private async flush(out: Outbound[], sender?: Phone): Promise<void> {
    const groups = new Map<Phone, MessageIntent[]>();
    for (const o of out) groups.set(o.phone, [...(groups.get(o.phone) ?? []), o.intent]);

    // One person's texts go out in order, each phrased knowing what the previous one said (no double greetings).
    const deliver = async (phone: Phone) => {
      const context: Turn[] = this.historyOf(phone).slice(-4);
      const trip = this.tripOf(phone);
      for (const intent of pairAcks(groups.get(phone)!)) {
        const text = trip ? fixNames(await this.deps.phrase(intent, context), trip) : await this.deps.phrase(intent, context);
        context.push({ from: "bot", text });
        if (this.lastSent.get(phone) === text) continue; // never repeat ourselves word for word
        try {
          await this.deps.transport.send(phone, text);
          this.lastSent.set(phone, text);
          this.remember(phone, "bot", text);
          this.count(phone, "texts");
          this.deps.onPulse?.(phone, "out", pulseTopic(intent));
        } catch (err) {
          console.error(`[engine] send failed: ${(err as Error).message}`);
          if (intent.kind === "invited") await this.inviteFailed(phone, intent.name);
        }
      }
    };
    // The person who just texted is waiting on us: their reply goes first. Everyone else follows, in parallel.
    if (sender && groups.has(sender)) await deliver(sender);
    await Promise.all([...groups.keys()].filter((p) => p !== sender).map(deliver));
    if (groups.size) this.deps.store.save(); // keep the chat history we just added
  }

  /**
   * We couldn't text an invitee first (shared pool). Their number is already registered, so it only needs them to
   * text in once. Give the organizer a ready-made invite as its own message, easy to copy and forward.
   */
  private async inviteFailed(phone: Phone, name: string): Promise<void> {
    const trip = this.tripOf(phone);
    if (!trip) return;
    const line = this.deps.transport.lineFor?.(phone) || this.ctx.cfg.agentNumber;
    const who = name || "them";
    const org = organizerName(trip);
    const heads = clip(`i can't text ${who} first, but they're all set up. copy the next message and send it to them:`);
    const invite = clip(line
      ? `hey${name ? ` ${name}` : ""}, i'm planning ${trip.title} with Roundup, an AI that sorts it out 1:1. text "hi" to ${line} to join`
      : `hey${name ? ` ${name}` : ""}, i'm planning ${trip.title} with Roundup, an AI that sorts it out 1:1. text "hi" to the Roundup number to join`);
    this.log(trip, "handoff", `couldn't reach ${name || "an invitee"}, gave ${org} an invite to forward`);
    try {
      await this.deps.transport.send(trip.organizer, heads);
      await this.deps.transport.send(trip.organizer, invite);
    } catch (err) {
      console.error(`[engine] could not tell organizer: ${(err as Error).message}`);
    }
  }
}

/** Does this parsed reply actually answer the question we asked? */
function answers(ask: Ask, p: ParsedReply): boolean {
  switch (ask.topic) {
    case "rsvp": return p.rsvp !== null;
    case "budget": return p.intent === "answer";
    case "drive": return p.canDrive !== null;
    case "seats": return p.seats !== null || p.canDrive === false;
    case "item": return p.itemYes !== null;
    case "poll": return p.rsvp !== null || p.itemYes !== null;
    default: return false;
  }
}

/** "awesome!" + the next question become one text (and one model call), if they fit in a single message. */
function pairAcks(intents: MessageIntent[]): MessageIntent[] {
  const out: MessageIntent[] = [];
  for (let i = 0; i < intents.length; i++) {
    const cur = intents[i];
    const next = intents[i + 1];
    if (cur.kind === "ack" && next && template(cur).length + template(next).length < 158) {
      out.push({ kind: "pair", first: cur, second: next });
      i++;
    } else out.push(cur);
  }
  return out;
}

/** Models sometimes write "sam" or "beach day"; names and the trip title always go out as written. "??" -> "?". */
export function fixNames(text: string, trip: Trip): string {
  const proper = [trip.title, ...Object.values(trip.members).map((m) => m.name)].filter((n) => n && n.length > 1);
  let out = text.replace(/\?{2,}/g, "?");
  for (const n of proper) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), n);
  }
  return out;
}

/** The organizer's summary of a member's message: no money, no numbers they didn't say, never their budget. */
function safeNote(note: string | null | undefined, m: Member, facts: string, text: string): string | null {
  const n = note?.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!n || /\$|\bbudget\b|\bbucks\b|\bdollars?\b/i.test(n)) return null;
  if (m.budgetCap !== null && new RegExp(`\\b${m.budgetCap}\\b`).test(n)) return null;
  return replyIsGrounded(n, facts, text) ? n : null;
}

/**
 * The catch in an RSVP, if there is one: "yeah as long as were back by 8" -> "as long as were back by 8".
 * Only clear conditions (times, "as long as", "only if"...), never money.
 */
export function rsvpCondition(text: string): string | null {
  const t = text.trim();
  const m = t.match(/\b(as long as .+|only if .+|unless .+|but (?:i |im |i'm |i'?ll |i have |i gotta |i need |not |only |no |gotta |have to |need to ).+|(?:need|have|gotta|got) to (?:be back|leave|head out|go) .+|not (?:waking|getting) up .+|(?:back|home|leave|leaving) by .+|(?:after|before|till|until) \d.*)$/i);
  if (!m) return null;
  const c = m[1].replace(/[.!]+$/, "").trim();
  if (c.length < 6 || c.length > 120 || /\$|\bbudget\b|\bbucks\b|\bdollars?\b/i.test(c)) return null;
  return c;
}

/** The topic word for a pulse (Dashboard.md 4.2): what kind of text it was, never its content. */
function pulseTopic(i: MessageIntent): string | null {
  const k = i.kind === "pair" ? i.second.kind : i.kind;
  if (k === "ask_rsvp") return "rsvp";
  if (k === "ask_budget") return "budget";
  if (k === "ask_drive" || k === "ask_seats") return "drive";
  if (k === "ask_item") return "item";
  if (k === "ask_poll") return "question";
  return null;
}
