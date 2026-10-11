// Silence handling (spec 9.4): one gentle nudge, then give up on that question and let the chain move on.
import type { Member, Trip } from "../types.js";
import { MAX_UNANSWERED, itemLabel, sendNextQueued } from "./asks.js";
import type { Ctx } from "./context.js";
import { reportPollIfDone, syncAttendance } from "./poll.js";

export function checkSilence(ctx: Ctx, trip: Trip): void {
  const now = ctx.now();
  for (const m of Object.values(trip.members)) {
    const ask = m.pendingAsk;
    if (!ask || m.optedOut) continue;
    const age = now - ask.askedAt;
    if (age >= ctx.cfg.giveUpAfterMs) {
      giveUp(ctx, trip, m);
    } else if (age >= ctx.cfg.nudgeAfterMs && !ask.nudged) {
      ask.nudged = true;
      ctx.out(m.phone, { kind: "nudge", topic: ask.topic, item: itemLabel(trip, ask), name: m.name });
      ctx.log(trip, "nudged", `nudged ${m.name || "a new member"}`);
    }
  }
  // A chain can't wait on someone whose question is stuck behind the 2-unanswered cap.
  for (const need of trip.needs) {
    const m = need.waitingOn ? trip.members[need.waitingOn] : null;
    if (!m || m.pendingAsk?.needId === need.id) continue;
    const queued = m.askQueue.some((a) => a.needId === need.id);
    if (queued && !m.pendingAsk && m.sentSinceReply >= MAX_UNANSWERED) {
      m.askQueue = m.askQueue.filter((a) => a.needId !== need.id);
      need.waitingOn = null;
      ctx.log(trip, "nudged", `${m.name} is quiet, moving on`);
    }
  }
  syncAttendance(ctx, trip);
  reportPollIfDone(ctx, trip);
}

/** Stop waiting on this question. If they answer later, the answer is still applied (staleAsk). */
function giveUp(ctx: Ctx, trip: Trip, m: Member): void {
  const ask = m.pendingAsk!;
  m.staleAsk = ask;
  m.pendingAsk = null;
  m.unclearCount = 0;
  const need = trip.needs.find((n) => n.id === ask.needId);
  if (need && need.waitingOn === m.phone) need.waitingOn = null;
  ctx.log(trip, "nudged", `no answer from ${m.name || "a new member"}, moving on`);
  sendNextQueued(ctx, trip, m);
}
