// One question at a time per member (spec 9.2). New questions wait in askQueue until the open one resolves.
import type { Ask, AskTopic, Member, MessageIntent, Trip } from "../types.js";
import { newId } from "../util.js";
import { type Ctx, isGoing, organizerName } from "./context.js";

/** A member who got 2 questions/nudges with no reply is not sent more until they reply. */
export const MAX_UNANSWERED = 2;

export function enqueueAsk(ctx: Ctx, trip: Trip, m: Member, topic: AskTopic, needId: string | null = null): void {
  if (m.optedOut) return;
  const ask: Ask = { id: newId("ask"), topic, needId, askedAt: 0, nudged: false };
  m.askQueue.push(ask);
  sendNextQueued(ctx, trip, m);
}

/** Close the open question and send the next queued one, if any. */
export function resolvePending(ctx: Ctx, trip: Trip, m: Member): void {
  m.pendingAsk = null;
  m.unclearCount = 0;
  sendNextQueued(ctx, trip, m);
}

export function sendNextQueued(ctx: Ctx, trip: Trip, m: Member): void {
  if (m.pendingAsk || m.optedOut) return;
  while (m.askQueue.length > 0) {
    const next = m.askQueue[0];
    if (!stillRelevant(trip, m, next)) {
      m.askQueue.shift();
      continue;
    }
    if (m.sentSinceReply >= MAX_UNANSWERED) return; // hold until they reply
    m.askQueue.shift();
    next.askedAt = ctx.now();
    m.pendingAsk = next;
    ctx.out(m.phone, askIntent(trip, m, next));
    const need = trip.needs.find((n) => n.id === next.needId);
    if (need) ctx.log(trip, "asked", need.kind === "seats" ? `asked ${m.name} to drive` : `asked ${m.name} to bring a ${need.label}`);
    return;
  }
}

/** Drop any open or queued question about `needId` for this member. */
export function cancelAsksFor(ctx: Ctx, trip: Trip, m: Member, needId: string): void {
  m.askQueue = m.askQueue.filter((a) => a.needId !== needId);
  if (m.staleAsk?.needId === needId) m.staleAsk = null;
  if (m.pendingAsk?.needId === needId) resolvePending(ctx, trip, m);
}

function stillRelevant(trip: Trip, m: Member, ask: Ask): boolean {
  if (ask.topic === "rsvp") return m.rsvp === "unknown";
  if (ask.topic === "budget") return isGoing(m) && m.budgetCap === null;
  if (ask.needId) {
    const need = trip.needs.find((n) => n.id === ask.needId);
    return !!need && need.status !== "filled" && need.waitingOn === m.phone;
  }
  return true;
}

export function askIntent(trip: Trip, m: Member, ask: Ask): MessageIntent {
  const need = trip.needs.find((n) => n.id === ask.needId);
  switch (ask.topic) {
    case "name":
      return trip.organizer === m.phone
        ? { kind: "ask_name_organizer" }
        : { kind: "ask_name_member", trip: trip.title, organizer: organizerName(trip) };
    case "rsvp": return { kind: "ask_rsvp", name: m.name, trip: trip.title, date: trip.dateText };
    case "budget": return { kind: "ask_budget", name: m.name };
    case "drive": return { kind: "ask_drive", name: m.name, trip: trip.title };
    case "seats": return { kind: "ask_seats", name: m.name };
    case "item": return { kind: "ask_item", name: m.name, item: need?.label ?? "something", trip: trip.title };
  }
}

export function itemLabel(trip: Trip, ask: Ask | null): string | null {
  if (!ask?.needId) return null;
  const need = trip.needs.find((n) => n.id === ask.needId);
  return need?.kind === "item" ? need.label : null;
}
