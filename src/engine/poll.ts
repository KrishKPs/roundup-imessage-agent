// "ask everyone <question>": the organizer's question goes to each member 1:1 (one question at a time, like
// everything else), answers are tallied, and the organizer gets one summary once everyone has answered.
import type { Ask, Member, Trip } from "../types.js";
import { newId } from "../util.js";
import { enqueueAsk } from "./asks.js";
import { type Ctx, organizerName } from "./context.js";

/** "ask everyone if 10am saturday works??" -> "10am saturday works?" (null if it isn't a poll request). */
export function parsePollRequest(raw: string): string | null {
  const m = raw.trim().match(
    /^(?:(?:can|could) you |pls |please )?(?:ask|check with|poll)\s+(?:everyone|everybody|the group|all|people|the crew|y'?all|them all)\b[\s,:-]*(?:if |whether )?(.+)$/i,
  );
  if (!m) return null;
  const q = m[1].trim().replace(/[?!.\s]+$/, "");
  return q.length >= 3 ? `${q.slice(0, 110)}?` : null;
}

/** People we can actually reach right now (shared pool: only those who've texted us). */
function reachable(trip: Trip, m: Member): boolean {
  if (m.phone === trip.organizer || m.optedOut || m.rsvp === "no" || !m.name) return false;
  return !((m.viaLink || m.invited) && !m.heardFrom);
}

export function startPoll(ctx: Ctx, trip: Trip, question: string): void {
  const people = Object.values(trip.members).filter((m) => reachable(trip, m));
  if (!people.length) {
    ctx.out(trip.organizer, { kind: "text", text: "nobody's joined yet, so there's no one to ask. share your link first!" });
    return;
  }
  const poll = { id: newId("poll"), question, askedAt: ctx.now(), asked: people.map((m) => m.phone), answers: {}, reported: false };
  trip.poll = poll; // replaces any older question; its unsent asks are dropped as no longer relevant
  for (const m of people) enqueueAsk(ctx, trip, m, "poll", null, poll.id);
  const who = people.length <= 3 ? people.map((m) => m.name).join(", ") : `all ${people.length} people`;
  ctx.out(trip.organizer, { kind: "text", text: `on it, asking ${who} now. i'll text you once everyone answers.` });
  ctx.log(trip, "asked", `${organizerName(trip)} asked everyone a question`);
}

export function recordPollAnswer(ctx: Ctx, trip: Trip, m: Member, ask: Ask, value: "yes" | "no" | "maybe"): void {
  ctx.out(m.phone, { kind: "text", text: `got it, i'll let ${organizerName(trip)} know.` });
  const poll = trip.poll;
  if (!poll || poll.id !== ask.pollId) return; // an older question the organizer has since replaced
  poll.answers[m.phone] = value;
  ctx.log(trip, "answered", `${m.name} answered ${organizerName(trip)}'s question`);
  reportPollIfDone(ctx, trip);
}

/** Done when everyone asked has answered, dropped out, or gone quiet past the give-up time. */
export function reportPollIfDone(ctx: Ctx, trip: Trip): void {
  const poll = trip.poll;
  if (!poll || poll.reported) return;
  const live = (p: string) => {
    const m = trip.members[p];
    if (!m || m.optedOut || m.rsvp === "no" || p in poll.answers) return false;
    return m.pendingAsk?.pollId === poll.id || m.askQueue.some((a) => a.pollId === poll.id);
  };
  if (poll.asked.some(live)) return;
  poll.reported = true;
  ctx.out(trip.organizer, { kind: "text", text: pollSummary(trip) });
}

/** `"10am saturday works?": 3 yes, 1 no (Sam), no answer from Maya` */
export function pollSummary(trip: Trip): string {
  const poll = trip.poll!;
  const by = (v: "yes" | "no" | "maybe") => poll.asked.filter((p) => poll.answers[p] === v).map((p) => trip.members[p]?.name || "someone");
  const yes = by("yes");
  const no = by("no");
  const maybe = by("maybe");
  const silent = poll.asked.filter((p) => !(p in poll.answers) && !trip.members[p]?.optedOut && trip.members[p]?.rsvp !== "no");
  const parts = [`${yes.length} yes`];
  if (no.length) parts.push(`${no.length} no (${no.join(", ")})`);
  if (maybe.length) parts.push(`${maybe.length} maybe (${maybe.join(", ")})`);
  if (silent.length) parts.push(`${poll.reported ? "no answer from" : "waiting on"} ${silent.map((p) => trip.members[p]?.name || "someone").join(", ")}`);
  return `"${poll.question}" ${parts.join(", ")}`;
}
