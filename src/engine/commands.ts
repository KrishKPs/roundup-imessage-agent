// Exact text commands (spec 8), matched in code before any LLM call.
import type { Member, Phone, State, Trip } from "../types.js";
import { newId, normalizePhone, parseName } from "../util.js";
import { enqueueAsk } from "./asks.js";
import { newNeed, releaseCommitments } from "./chain.js";
import { type Ctx, goingMembers, organizerName, seatsNeed } from "./context.js";
import { budgetAnsweredCount, finalize } from "./plan.js";
import { findJoinCode, organizerVerb, parsePeople, parseTripRequest, textAfterCode } from "./intents.js";

export function newMember(phone: Phone, name: string, now: number): Member {
  return {
    phone, name, rsvp: "unknown", budgetCap: null, canDrive: null, seats: null, bringing: [],
    pendingAsk: null, askQueue: [], unclearCount: 0, optedOut: false, joinedAt: now,
    carHint: false, staleAsk: null, sentSinceReply: 0, lastPlan: null,
  };
}

export function makeCode(title: string, taken: Set<string>): string {
  const base = (title.replace(/[^a-z]/gi, "").toUpperCase() || "TRIP").slice(0, 5).padEnd(3, "X");
  for (let i = 0; i < 100; i++) {
    const code = `${base}${2 + ((i * 7 + title.length) % 8)}${i >= 8 ? i : ""}`.slice(0, 6);
    if (!taken.has(code)) return code;
  }
  return newId("T").slice(-6).toUpperCase();
}

/** Any name this phone gave us before, in any trip. */
function knownName(state: State, phone: Phone): string {
  for (const t of Object.values(state.trips)) if (t.members[phone]?.name) return t.members[phone].name;
  return "";
}

export interface CommandEnv {
  ctx: Ctx;
  state: State;
  resetState(): void;
}

/** Returns true if the text was a command and has been handled. */
export function handleCommand(env: CommandEnv, phone: Phone, text: string): boolean {
  const { ctx, state } = env;
  const t = text.trim();
  const lower = t.toLowerCase().replace(/[.!]+$/, "");
  const trip = state.phoneTrip[phone] ? state.trips[state.phoneTrip[phone]] : undefined;
  const isOrganizer = !!trip && trip.organizer === phone;

  if (lower === "reset" && ctx.cfg.demoMode) {
    env.resetState();
    ctx.out(phone, { kind: "text", text: "all clear, everything's reset." });
    return true;
  }

  if (/^(stop|unsubscribe|stop texting me)$/.test(lower)) {
    if (!trip?.members[phone]) {
      ctx.out(phone, { kind: "stop_confirm" });
      return true;
    }
    optOut(ctx, trip, trip.members[phone]);
    return true;
  }

  // Joining: a known code anywhere in the message, unless they're already in that trip.
  const code = findJoinCode(t, Object.values(state.trips).map((x) => x.code));
  if (code && !(trip && trip.code === code && trip.members[phone])) {
    const after = textAfterCode(t, code);
    joinTrip(env, phone, code, after ? parseName(after) : null);
    return true;
  }
  if (/^join\b/i.test(t) && !trip?.members[phone]) {
    ctx.out(phone, { kind: "unknown_code" });
    return true;
  }

  // Organizer typed or pasted phone numbers: add those people.
  const typed = parsePeople(t);
  if (typed.length && trip?.members[phone]) {
    addPeople(env, phone, typed);
    return true;
  }

  // Starting a trip: free text from someone not in a trip, or an explicit "new trip ..." from anyone.
  const explicitNew = /^(new|plan a new|start a new|another)\b.*\b(trip|getaway|vacation|weekend|outing|hike|party|day)\b/i.test(t);
  if (!trip?.members[phone] || explicitNew) {
    const req = parseTripRequest(t.replace(/^new trip\s*:?\s*/i, "new trip "));
    if (req) {
      createTrip(env, phone, req.title, req.dateText);
      return true;
    }
  }

  const verb = organizerVerb(t);
  const organizerCmd = verb !== null || /^need\s+/i.test(t);
  if (!organizerCmd || !trip) return false;
  if (!isOrganizer) {
    ctx.out(phone, { kind: "not_organizer", organizer: organizerName(trip) });
    return true;
  }

  if (verb === "start") {
    if (trip.status !== "collecting_members") {
      ctx.out(phone, { kind: "text", text: "already rolling! text status to see where things are." });
      return true;
    }
    trip.status = "coordinating";
    trip.startedAt = ctx.now();
    const others = Object.values(trip.members).filter((m) => m.phone !== phone && m.name && !m.optedOut);
    ctx.out(phone, { kind: "started_organizer", count: others.length });
    // The organizer is going by definition; ask them for a budget like everyone else.
    enqueueAsk(ctx, trip, trip.members[phone], "budget");
    for (const m of others) enqueueAsk(ctx, trip, m, "rsvp");
    return true;
  }

  if (verb === "status") {
    ctx.out(phone, { kind: "text", text: statusText(trip) });
    return true;
  }

  if (verb === "plan") {
    finalize(ctx, trip);
    return true;
  }

  // need <item>, <item>
  const items = t.replace(/^need\s+/i, "").split(/,|\band\b/).map((s) => s.trim().replace(/^(a|an|the)\s+/i, "").toLowerCase()).filter(Boolean);
  const added = items.filter((label) => !trip.needs.some((n) => n.kind === "item" && n.label === label));
  for (const label of added) trip.needs.push(newNeed("item", label, 1));
  if (trip.status === "finalized" && added.length) trip.status = "coordinating";
  ctx.out(phone, { kind: "needs_added", items: added.length ? added : items });
  return true;
}

export function createTrip(env: CommandEnv, phone: Phone, title: string, dateText: string | null): void {
  const { ctx, state } = env;
  const now = ctx.now();
  const code = makeCode(title, new Set(Object.values(state.trips).map((t) => t.code)));
  const name = knownName(state, phone);
  const organizer = newMember(phone, name, now);
  organizer.rsvp = "yes";
  const trip: Trip = {
    id: newId("trip"), code, title, dateText, organizer: phone, status: "collecting_members",
    members: { [phone]: organizer }, needs: [], log: [], createdAt: now, startedAt: null,
  };
  state.trips[trip.id] = trip;
  state.phoneTrip[phone] = trip.id;
  if (state.awaitingPlan) delete state.awaitingPlan[phone];
  if (name) sendTripCreated(ctx, trip);
  else enqueueAsk(ctx, trip, organizer, "name");
}

export function sendTripCreated(ctx: Ctx, trip: Trip): void {
  const org = trip.members[trip.organizer];
  ctx.out(org.phone, { kind: "trip_created", name: org.name, trip: trip.title, code: trip.code });
  ctx.out(org.phone, { kind: "invite_line", trip: trip.title, code: trip.code, organizer: org.name, agentNumber: ctx.cfg.agentNumber || null });
  ctx.log(trip, "joined", `${org.name} started ${trip.title}`);
}

function joinTrip(env: CommandEnv, phone: Phone, code: string, givenName: string | null): void {
  const { ctx, state } = env;
  const trip = Object.values(state.trips).find((t) => t.code === code);
  if (!trip) {
    ctx.out(phone, { kind: "unknown_code" });
    return;
  }
  const existing = trip.members[phone];
  if (existing?.optedOut) return; // stop is permanent
  state.phoneTrip[phone] = trip.id;
  if (existing) {
    ctx.out(phone, { kind: "already_member", trip: trip.title });
    return;
  }
  const name = givenName ?? knownName(state, phone);
  const m = newMember(phone, name, ctx.now());
  trip.members[phone] = m;
  if (name) welcome(ctx, trip, m);
  else enqueueAsk(ctx, trip, m, "name");
}

/** First contact: always says it's an AI (spec 10.5). Then asks RSVP if the trip is already moving. */
export function welcome(ctx: Ctx, trip: Trip, m: Member): void {
  ctx.log(trip, "joined", `${m.name} joined`);
  const waiting = trip.status === "collecting_members";
  if (m.invited) {
    // They already got the AI intro with the invite; keep it to one short line.
    const rest = waiting ? ` i'll text you once ${organizerName(trip)} kicks things off.` : "";
    ctx.out(m.phone, { kind: "text", text: `nice to meet you ${m.name}!${rest}` });
  } else {
    ctx.out(m.phone, { kind: "intro", name: m.name, trip: trip.title, organizer: organizerName(trip) });
    if (waiting) ctx.out(m.phone, { kind: "waiting_for_start", organizer: organizerName(trip) });
  }
  if (!waiting) enqueueAsk(ctx, trip, m, "rsvp");
}

export function optOut(ctx: Ctx, trip: Trip, m: Member): void {
  ctx.out(m.phone, { kind: "stop_confirm" }); // queued before the flag, so it is the last thing they get
  const wasGoing = m.rsvp === "yes" || m.rsvp === "maybe";
  releaseCommitments(ctx, trip, m);
  m.optedOut = true;
  m.rsvp = "no";
  m.pendingAsk = null;
  m.askQueue = [];
  m.staleAsk = null;
  ctx.log(trip, "dropped", `${m.name || "someone"} opted out`);
  if (wasGoing && m.phone !== trip.organizer) ctx.out(trip.organizer, { kind: "organizer_drop", name: m.name });
}

export function statusText(trip: Trip): string {
  const going = goingMembers(trip);
  const waiting = Object.values(trip.members).filter((m) => !m.optedOut && m.rsvp === "unknown");
  const parts = [`${trip.title}: ${going.length} in`];
  if (waiting.length) parts.push(`${waiting.length} haven't answered`);
  const seats = seatsNeed(trip);
  if (seats) parts.push(`seats ${seats.quantityFilled}/${seats.quantityNeeded}`);
  for (const n of trip.needs.filter((x) => x.kind === "item")) parts.push(`${n.label} ${n.status === "filled" ? "covered" : "open"}`);
  const b = budgetAnsweredCount(trip);
  parts.push(`budget ${b.answered}/${b.total} answered`);
  return `${parts.join(", ")}.`;
}

/**
 * The organizer shares contact cards or types numbers: register and invite each person (spec 10.3, as amended:
 * Roundup only texts people the organizer added or who texted first, and the first text says it's an AI).
 */
export function addPeople(env: CommandEnv, phone: Phone, people: { name: string | null; phone: string }[]): void {
  const { ctx, state } = env;
  const trip = state.phoneTrip[phone] ? state.trips[state.phoneTrip[phone]] : undefined;
  if (!trip?.members[phone]) {
    ctx.out(phone, { kind: "add_needs_trip" });
    return;
  }
  if (trip.organizer !== phone) {
    ctx.out(phone, { kind: "not_organizer", organizer: organizerName(trip) });
    return;
  }
  const optedOutAnywhere = (p: Phone) => Object.values(state.trips).some((t) => t.members[p]?.optedOut);
  const added: string[] = [];
  let skipped = 0;
  for (const person of people) {
    const p = normalizePhone(person.phone);
    if (p === phone || trip.members[p] || optedOutAnywhere(p)) {
      skipped += 1;
      continue;
    }
    const name = person.name ?? knownName(state, p);
    const m = newMember(p, name, ctx.now());
    m.invited = true;
    trip.members[p] = m;
    state.phoneTrip[p] = trip.id;
    ctx.out(p, { kind: "invited", name, trip: trip.title, organizer: organizerName(trip), date: trip.dateText });
    ctx.log(trip, "joined", `${organizerName(trip)} added ${name || "someone"}`);
    if (!name) enqueueAsk(ctx, trip, m, "name");
    else if (trip.status !== "collecting_members") enqueueAsk(ctx, trip, m, "rsvp");
    added.push(name || "1 person");
  }
  ctx.out(phone, { kind: "people_added", names: added.length ? added : ["nobody new"], skipped, started: trip.status !== "collecting_members" });
}
