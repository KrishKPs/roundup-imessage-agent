// Silence handling (spec 9.4): one gentle nudge, then give up on that question and let the chain move on.
import type { Member, Trip } from "../types.js";
import { MAX_UNANSWERED, itemLabel, sendNextQueued } from "./asks.js";
import type { Ctx } from "./context.js";
import { findPoll, reportPollIfDone, syncAttendance } from "./poll.js";
import { stepQuestion } from "./prefs.js";
import type { Ask } from "../types.js";

/** The actual question, so a nudge or re-ask never arrives without context ("no rush. say skip" about what?). */
export function restate(trip: Trip, ask: Ask): string | null {
  if (ask.topic === "interview" && ask.step) return stepQuestion(trip, ask.step);
  if (ask.topic === "poll") return findPoll(trip, ask.pollId)?.question ?? null;
  return null;
}

/** Optional questions are never nudged: nobody needs a reminder about "anything you're hoping to do?". */
const NO_NUDGE = new Set(["interview", "interest", "constraint"]);

export function checkSilence(ctx: Ctx, trip: Trip): void {
  const now = ctx.now();
  for (const m of Object.values(trip.members)) {
    const ask = m.pendingAsk;
    if (!ask || m.optedOut) continue;
    const age = now - ask.askedAt;
    if (age >= ctx.cfg.giveUpAfterMs) {
      giveUp(ctx, trip, m);
    } else if (age >= ctx.cfg.nudgeAfterMs && !ask.nudged && !NO_NUDGE.has(ask.topic)) {
      ask.nudged = true;
      ctx.out(m.phone, { kind: "nudge", topic: ask.topic, item: itemLabel(trip, ask), name: m.name, question: restate(trip, ask) });
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
