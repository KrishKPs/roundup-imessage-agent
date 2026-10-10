// The engine: every inbound text and timer tick comes through here. Pure logic, no Spectrum.
// Events run one at a time (a simple promise lock), so state never changes under our feet.
import type { Phraser } from "../llm/phrase.js";
import type { Understander } from "../llm/understand.js";
import type { TripExtractor } from "../llm/tripRequest.js";
import { type ConverseInput, type ConverseResult, type Converser, type Turn, replyIsGrounded } from "../llm/converse.js";
import { keywordParse } from "../llm/understand.js";
import { factsFor } from "./facts.js";
import { titleFromAnything } from "./intents.js";
import type { Store } from "../store.js";
import type { Transport } from "../transport/transport.js";
import type { Ask, LogKind, Member, MessageIntent, Outbound, ParsedReply, Phone, Trip } from "../types.js";
import { clip, normalizePhone, parseName } from "../util.js";
import { template } from "../llm/phrase.js";
import { askIntent, enqueueAsk, itemLabel, resolvePending, sendNextQueued } from "./asks.js";
import { applyChainAnswer, newNeed, recomputeSeats, releaseCommitments, runChain } from "./chain.js";
import {
  type CommandEnv, type WebPerson, addPeople, setDate, createTrip, createWebTrip, greetWebSignup, handleCommand, joinWebTrip, optOut,
  sendTripCreated, welcome,
} from "./commands.js";
import { type Ctx, type EngineConfig, isGoing, organizerName, seatsNeed } from "./context.js";
import { finalize } from "./plan.js";
import { type SeedInput, buildDemoTrip } from "./seed.js";
import { recordPollAnswer, startPoll } from "./poll.js";
import { checkSilence } from "./timers.js";

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
        else if (trip.status !== "collecting_members" && m.rsvp === "unknown") enqueueAsk(this.ctx, trip, m, "rsvp");
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
  async createTripFromWeb(input: WebPerson & { title: string; dateText: string | null }): Promise<string> {
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

  private prefetched: Promise<ConverseResult | null> | null = null;

  private converseInput(trip: Trip, m: Member, text: string): ConverseInput {
    return {
      role: m.phone === trip.organizer ? "organizer" : "member", name: m.name, text,
      facts: factsFor(trip, m, this.ctx), history: this.historyOf(m.phone).slice(-9, -1),
    };
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
          startPoll(ctx, trip, `${res.question.trim().replace(/[?!.\s]+$/, "")}?`, res.open ?? undefined);
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
    } else if (res.action === "pass_to_organizer") {
      ctx.out(m.phone, { kind: "text", text: reply ?? `good question, i'll check with ${organizerName(trip)} and get back to you.` });
      ctx.out(trip.organizer, { kind: "question_organizer", name: m.name || "someone" });
      ctx.log(trip, "handoff", `passed ${m.name || "someone"}'s question to ${organizerName(trip)}`);
      return true;
    }
    if (!reply) return false;
    ctx.out(m.phone, { kind: "text", text: reply });
    // Keep the conversation on track: repeat the open question unless the reply already asks something.
    if (m.pendingAsk && !reply.includes("?")) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
    return true;
  }

  private env(): CommandEnv {
    return { ctx: this.ctx, state: this.state, resetState: () => this.deps.store.reset() };
  }

  /** Called every 15 seconds: nudges, give-ups, and time-based progress. */
  tick(): Promise<void> {
    return this.run(async () => {
      for (const trip of Object.values(this.state.trips)) {
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

    // An open question from the organizer ("which days are you free?"): their words are the answer.
    if (ask?.topic === "poll" && trip.poll?.open && ask.pollId === trip.poll.id && !/\?\s*$/.test(text)
        && keywordParse(text, null).intent !== "drop") {
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
      return this.unclear(trip, m, ask);
    }
    if (isStale) m.staleAsk = null;
    this.applyAnswer(trip, m, ask, parsed, isStale);
  }

  private applyAnswer(trip: Trip, m: Member, ask: Ask, parsed: ParsedReply, isStale: boolean): void {
    const ctx = this.ctx;
    const close = () => (isStale ? undefined : resolvePending(ctx, trip, m));

    if (ask.topic === "rsvp") {
      m.rsvp = parsed.rsvp!;
      if (parsed.canDrive) {
        m.carHint = true;
        if (parsed.seats) m.seats = parsed.seats;
      }
      if (parsed.canDrive === false) m.carHint = false;
      ctx.out(m.phone, { kind: "ack", topic: "rsvp", value: parsed.rsvp! });
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
    if (result === "ignored") ctx.out(m.phone, { kind: "late_ack" });
    else ctx.out(m.phone, { kind: "ack", topic: ask.topic, value: result === "provided" ? "yes" : "no" });
    close();
  }

  /** Confidence too low: re-ask once more simply, then hand off to the organizer (spec 8). */
  private unclear(trip: Trip, m: Member, ask: Ask): void {
    const ctx = this.ctx;
    m.unclearCount += 1;
    if (m.unclearCount < 2) {
      ctx.out(m.phone, { kind: "reask", topic: ask.topic, item: itemLabel(trip, ask) });
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

    let seats = seatsNeed(trip);
    if (!seats) {
      const answered = named.filter((m) => m.rsvp !== "unknown").length;
      const timedOut = trip.startedAt !== null && ctx.now() - trip.startedAt >= ctx.cfg.nudgeAfterMs;
      if (answered === named.length || (answered * 2 >= named.length && timedOut)) {
        seats = newNeed("seats", "seats", 0);
        trip.needs.unshift(seats);
      }
    }
    if (!seats) return;

    recomputeSeats(trip);
    runChain(ctx, trip, seats);
    if (seats.status !== "open") {
      for (const need of trip.needs) {
        if (need.kind !== "item") continue;
        runChain(ctx, trip, need);
        if (need.status === "open") break; // item chains run one at a time
      }
    }

    const done = trip.needs.every((n) => n.status !== "open");
    const settled = Object.values(trip.members).every(
      (m) => m.optedOut || (!m.pendingAsk && (m.askQueue.length === 0 || m.sentSinceReply >= 2)),
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
    if (m && QUESTION_KINDS.has(intent.kind)) m.sentSinceReply += 1;
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
      for (const intent of pairAcks(groups.get(phone)!)) {
        const text = await this.deps.phrase(intent, context);
        context.push({ from: "bot", text });
        if (this.lastSent.get(phone) === text) continue; // never repeat ourselves word for word
        try {
          await this.deps.transport.send(phone, text);
          this.lastSent.set(phone, text);
          this.remember(phone, "bot", text);
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
      ? `hey${name ? ` ${name}` : ""}! i'm planning ${trip.title} with Roundup, an AI that sorts it out 1:1. text "hi" to ${line} to join`
      : `hey${name ? ` ${name}` : ""}! i'm planning ${trip.title} with Roundup, an AI that sorts it out 1:1. text "hi" to the Roundup number to join`);
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
