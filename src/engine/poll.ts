// "ask everyone <question>": the organizer's question goes to each member 1:1 (one question at a time, like
// everything else), answers are collected, and the organizer gets one summary once everyone has answered.
// Two kinds: yes/no questions ("does 10am saturday work?") are tallied; open questions ("which days are you free?")
// keep each person's words so the organizer (and the AI) can find a common option.
import type { Ask, Member, Phone, Poll, Trip } from "../types.js";
import { newId } from "../util.js";
import { enqueueAsk } from "./asks.js";
import { type Ctx, organizerName } from "./context.js";

/** "ask everyone if 10am saturday works??" -> "10am saturday works?" (null if it isn't a poll request). */
export function parsePollRequest(raw: string): string | null {
  const m = raw.trim().match(
    /^(?:(?:can|could) you |pls |please )?(?:ask|check with|poll)\s+(?:everyone|everybody|the group|all|people|the crew|y'?all|them all)\b[\s,:-]*(?:if |whether )?(.+)$/i,
  );
  if (!m) return null;
  // The organizer talks about the group ("what snacks they want"); members should read it to them.
  const q = m[1].trim().replace(/[?!.\s]+$/, "")
    .replace(/\bthey're\b/gi, "you're").replace(/\bare they\b/gi, "are you").replace(/\bthey are\b/gi, "you are")
    .replace(/\bthey\b/gi, "you").replace(/\btheir\b/gi, "your").replace(/\bthemselves\b/gi, "yourself").replace(/\bthem\b/gi, "you");
  return q.length >= 3 ? `${q.slice(0, 140)}?` : null;
}

/** Needs a free-text answer ("which days...", "what can you bring") rather than yes/no. */
export function isOpenQuestion(q: string): boolean {
  return /^(what|which|when|where|who|how|why)\b/i.test(q.trim()) || /\b(which|what) (days?|times?|dates?|day|time)\b/i.test(q);
}

/** People we can actually reach right now (shared pool: only those who've texted us). */
function reachable(trip: Trip, m: Member): boolean {
  if (m.phone === trip.organizer || m.optedOut || m.rsvp === "no" || !m.name) return false;
  return !((m.viaLink || m.invited) && !m.heardFrom);
}

export function startPoll(ctx: Ctx, trip: Trip, question: string, open = isOpenQuestion(question)): void {
  const people = Object.values(trip.members).filter((m) => reachable(trip, m));
  if (!people.length) {
    ctx.out(trip.organizer, { kind: "text", text: "nobody's joined yet, so there's no one to ask. share your link first!" });
    return;
  }
  const poll: Poll = { id: newId("poll"), question, open, askedAt: ctx.now(), asked: people.map((m) => m.phone), answers: {}, reported: false };
  trip.poll = poll; // replaces any older question
  for (const m of people) {
    if (m.pendingAsk?.topic === "poll") m.pendingAsk = null; // the old question is moot; ask the new one right away
    m.askQueue = m.askQueue.filter((a) => a.topic !== "poll");
    enqueueAsk(ctx, trip, m, "poll", null, poll.id);
  }
  const who = people.length <= 3 ? people.map((m) => m.name).join(", ") : `all ${people.length} people`;
  ctx.out(trip.organizer, { kind: "text", text: `on it, asking ${who} now. i'll text you once everyone answers.` });
  ctx.log(trip, "asked", `${organizerName(trip)} asked everyone a question`);
}

export function recordPollAnswer(ctx: Ctx, trip: Trip, m: Member, ask: Ask, answer: string): void {
  ctx.out(m.phone, { kind: "text", text: `got it, i'll let ${organizerName(trip)} know.` });
  const poll = trip.poll;
  if (!poll || poll.id !== ask.pollId) return; // an older question the organizer has since replaced
  poll.answers[m.phone] = answer.trim().slice(0, 200);
  ctx.log(trip, "answered", `${m.name} answered ${organizerName(trip)}'s question`);
  reportPollIfDone(ctx, trip);
}

/** Done when everyone asked has answered, dropped out, or gone quiet past the give-up time. */
export function reportPollIfDone(ctx: Ctx, trip: Trip): void {
  const poll = trip.poll;
  if (!poll || poll.reported) return;
  const live = (p: Phone) => {
    const m = trip.members[p];
    if (!m || m.optedOut || m.rsvp === "no" || p in poll.answers) return false;
    return m.pendingAsk?.pollId === poll.id || m.askQueue.some((a) => a.pollId === poll.id);
  };
  if (poll.asked.some(live)) return;
  poll.reported = true;
  const r = pollResults(trip);
  ctx.out(trip.organizer, { kind: "poll_report", question: poll.question, open: !!poll.open, answers: r.answers, silent: r.silent });
}

export function pollResults(trip: Trip): { answers: { name: string; answer: string }[]; silent: string[] } {
  const poll = trip.poll!;
  const name = (p: Phone) => trip.members[p]?.name || "someone";
  const answers = poll.asked.filter((p) => p in poll.answers).map((p) => ({ name: name(p), answer: poll.answers[p] }));
  const silent = poll.asked
    .filter((p) => !(p in poll.answers) && !trip.members[p]?.optedOut && trip.members[p]?.rsvp !== "no")
    .map(name);
  return { answers, silent };
}

/** Plain summary, used by status and as the no-AI fallback. */
export function pollSummary(trip: Trip): string {
  const poll = trip.poll!;
  const { answers, silent } = pollResults(trip);
  return summarizeAnswers(poll.question, !!poll.open, answers, silent, poll.reported);
}

export function summarizeAnswers(question: string, open: boolean, answers: { name: string; answer: string }[], silent: string[], done = true): string {
  const quiet = silent.length ? `${done ? "no answer from" : "waiting on"} ${silent.join(", ")}` : "";
  if (open) {
    const lines = answers.map((a) => `${a.name}: ${a.answer}`);
    return `"${question}" ${[...lines, quiet].filter(Boolean).join("; ")}`;
  }
  const by = (v: string) => answers.filter((a) => a.answer === v).map((a) => a.name);
  const parts = [`${by("yes").length} yes`];
  if (by("no").length) parts.push(`${by("no").length} no (${by("no").join(", ")})`);
  if (by("maybe").length) parts.push(`${by("maybe").length} maybe (${by("maybe").join(", ")})`);
  if (quiet) parts.push(quiet);
  return `"${question}" ${parts.join(", ")}`;
}

/** "tell everyone to bring sunscreen" / "announce: leaving at 9" -> the message (null if not an announcement). */
export function parseAnnouncement(raw: string): string | null {
  const m = raw.trim().match(/^(?:(?:can|could) you |pls |please )?(?:tell|remind|let)\s+(?:everyone|everybody|the group|all|people|y'?all)\s+(?:know\s+)?(?:that\s+|to\s+)?(.+)$|^announce\s*:?\s+(.+)$/i);
  const msg = (m?.[1] ?? m?.[2])?.trim();
  return msg && msg.length >= 3 ? msg.slice(0, 200) : null;
}

/** Send the organizer's note to everyone we can reach. Their words, clearly labeled as from them. */
export function announce(ctx: Ctx, trip: Trip, message: string): void {
  const people = Object.values(trip.members).filter((m) => reachable(trip, m));
  if (!people.length) {
    ctx.out(trip.organizer, { kind: "text", text: "nobody's joined yet, so there's no one to tell. share your link first!" });
    return;
  }
  const org = organizerName(trip);
  for (const m of people) ctx.out(m.phone, { kind: "text", text: `from ${org}: ${message}` });
  const who = people.length <= 3 ? people.map((m) => m.name).join(", ") : `all ${people.length} people`;
  ctx.out(trip.organizer, { kind: "text", text: `sent to ${who}.` });
  ctx.log(trip, "asked", `${org} sent everyone a note`);
}
