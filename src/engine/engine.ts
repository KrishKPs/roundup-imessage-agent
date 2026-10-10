// The engine: every inbound text and timer tick comes through here. Pure logic, no Spectrum.
// Events run one at a time (a simple promise lock), so state never changes under our feet.
import type { Phraser } from "../llm/phrase.js";
import type { Understander } from "../llm/understand.js";
import type { Store } from "../store.js";
import type { Transport } from "../transport/transport.js";
import type { Ask, LogKind, Member, MessageIntent, Outbound, ParsedReply, Phone, Trip } from "../types.js";
import { clip, normalizePhone, parseName } from "../util.js";
import { askIntent, enqueueAsk, itemLabel, resolvePending, sendNextQueued } from "./asks.js";
import { applyChainAnswer, newNeed, recomputeSeats, releaseCommitments, runChain } from "./chain.js";
import { type CommandEnv, handleCommand, optOut, sendTripCreated, welcome } from "./commands.js";
import { type Ctx, type EngineConfig, isGoing, organizerName, seatsNeed } from "./context.js";
import { finalize } from "./plan.js";
import { type SeedInput, buildDemoTrip } from "./seed.js";
import { checkSilence } from "./timers.js";

export interface EngineDeps {
  store: Store;
  transport: Transport;
  understand: Understander;
  phrase: Phraser;
  cfg: EngineConfig;
  now?: () => number;
  onChange?: () => void;
}

const QUESTION_KINDS = new Set<MessageIntent["kind"]>([
  "ask_name_member", "ask_name_organizer", "ask_rsvp", "ask_budget", "ask_drive", "ask_seats", "ask_item", "reask", "nudge",
]);

export class Engine {
  private lock: Promise<void> = Promise.resolve();
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
      const trip = this.tripOf(phone);
      const m = trip?.members[phone];
      if (m?.optedOut) return; // stop is permanent: never reply again
      if (m) m.sentSinceReply = 0;

      const env: CommandEnv = { ctx: this.ctx, state: this.state, resetState: () => this.deps.store.reset() };
      if (handleCommand(env, phone, body)) {
        const t = this.tripOf(phone);
        if (t) this.advance(t);
        return;
      }
      if (!trip || !m) {
        this.ctx.out(phone, { kind: "help" });
        return;
      }
      await this.handleReply(trip, m, body);
      sendNextQueued(this.ctx, trip, m); // release anything held while they were quiet
      this.advance(trip);
    });
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

  // ---------------------------------------------------------------- replies

  private async handleReply(trip: Trip, m: Member, text: string): Promise<void> {
    const ctx = this.ctx;
    const ask: Ask | null = m.pendingAsk ?? m.staleAsk;
    const isStale = !m.pendingAsk && !!m.staleAsk;

    if (ask?.topic === "name") {
      const name = parseName(text);
      if (!name) return this.unclear(trip, m, ask);
      m.name = name;
      resolvePending(ctx, trip, m);
      if (m.phone === trip.organizer) sendTripCreated(ctx, trip);
      else welcome(ctx, trip, m);
      return;
    }

    const parsed = await this.deps.understand(text, ask?.topic ?? null);

    if (parsed.intent === "opt_out") {
      optOut(ctx, trip, m);
      return;
    }
    if (parsed.intent === "drop" && m.rsvp !== "no") return this.dropout(trip, m);
    if (parsed.intent === "question") return this.answerQuestion(trip, m);
    if (!ask) return this.unprompted(trip, m, parsed);

    if (parsed.confidence < 0.6 || !answers(ask, parsed)) {
      if (isStale) return this.unprompted(trip, m, parsed);
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
  private answerQuestion(trip: Trip, m: Member): void {
    const ctx = this.ctx;
    ctx.out(m.phone, { kind: "question_answer", trip: trip.title, date: trip.dateText, organizer: organizerName(trip) });
    if (m.phone !== trip.organizer) ctx.out(trip.organizer, { kind: "question_organizer", name: m.name });
    if (m.pendingAsk) ctx.out(m.phone, askIntent(trip, m, m.pendingAsk));
  }

  /** A message when no question is open: changed answers ("actually i can drive") or chit-chat. */
  private unprompted(trip: Trip, m: Member, parsed: ParsedReply): void {
    const ctx = this.ctx;
    const seats = seatsNeed(trip);
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
    ctx.out(m.phone, trip.status === "collecting_members"
      ? { kind: "waiting_for_start", organizer: organizerName(trip) }
      : { kind: "all_set" });
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

  private run(fn: () => Promise<void>): Promise<void> {
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
      await this.flush(out);
    });
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Phrase and send. An ack followed by a question to the same person is merged into one text. */
  private async flush(out: Outbound[]): Promise<void> {
    const texts: { phone: Phone; text: string; isAck: boolean }[] = [];
    for (const o of out) texts.push({ phone: o.phone, text: await this.deps.phrase(o.intent), isAck: o.intent.kind === "ack" });

    const merged: { phone: Phone; text: string }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const cur = texts[i];
      const nextSame = texts.slice(i + 1).find((x) => x.phone === cur.phone);
      if (cur.isAck && nextSame && cur.text.length + nextSame.text.length < 160) {
        nextSame.text = clip(`${cur.text} ${nextSame.text}`);
        continue;
      }
      merged.push({ phone: cur.phone, text: cur.text });
    }
    for (const msg of merged) {
      try {
        await this.deps.transport.send(msg.phone, msg.text);
      } catch (err) {
        console.error(`[engine] send failed: ${(err as Error).message}`);
      }
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
    default: return false;
  }
}
