// The organizer's questions and notes, sent 1:1: "ask everyone ...", "ask Sam if ...", "tell Leo to ...".
// Each question goes to its people one at a time (like every other question), answers are kept in their own words,
// and the organizer gets one summary once everyone asked has answered. Several questions can be open at once.
import type { Ask, Member, Phone, Poll, Trip } from "../types.js";
import { newId } from "../util.js";
import { enqueueAsk } from "./asks.js";
import { type Ctx, organizerName } from "./context.js";

const EVERYONE = /^(everyone|everybody|the group|all|people|the crew|y'?all|them all|the gang)\b/i;

/** All the organizer's questions on this trip (older state kept a single `poll`). */
export function polls(trip: Trip): Poll[] {
  if (!trip.polls) trip.polls = trip.poll ? [trip.poll] : [];
  delete trip.poll;
  return trip.polls;
}

export function findPoll(trip: Trip, id: string | undefined): Poll | undefined {
  return id ? polls(trip).find((p) => p.id === id) : undefined;
}

export function latestPoll(trip: Trip): Poll | undefined {
  return polls(trip).at(-1);
}

// ---------------------------------------------------------------- who: everyone, or named people

export type Target = { kind: "everyone" } | { kind: "people"; phones: Phone[] } | { kind: "unknown"; names: string[] };

/** Match a name the organizer typed to a member: exact, then unique prefix, then one typo. Organizer excluded. */
export function findMember(trip: Trip, typed: string): Member | null {
  const t = typed.toLowerCase().replace(/[^a-z]/g, "");
  if (t.length < 2) return null;
  const pool = Object.values(trip.members).filter((m) => m.name && !m.optedOut && m.phone !== trip.organizer);
  const first = (m: Member) => m.name.toLowerCase().replace(/[^a-z]/g, "");
  const exact = pool.filter((m) => first(m) === t);
  if (exact.length === 1) return exact[0];
  const prefix = pool.filter((m) => t.length >= 3 && (first(m).startsWith(t) || t.startsWith(first(m))));
  if (prefix.length === 1) return prefix[0];
  const typo = pool.filter((m) => t.length >= 4 && editDistance(first(m), t) <= 1);
  return typo.length === 1 ? typo[0] : null;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
    }
  }
  return d[a.length][b.length];
}

/** Names from the model ("Sam", "maya") -> phones, or the ones we couldn't place. */
export function resolveNames(trip: Trip, names: string[] | null | undefined): Target {
  if (!names?.length || names.some((n) => EVERYONE.test(n.trim()))) return { kind: "everyone" };
  const phones: Phone[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const m = findMember(trip, n);
    if (m) phones.push(m.phone);
    else unknown.push(n.trim());
  }
  return unknown.length ? { kind: "unknown", names: unknown } : { kind: "people", phones: [...new Set(phones)] };
}

/**
 * "ask everyone if 10am works", "ask Sam if he can bring the tent", "tell Leo and Maya to bring snacks":
 * who it's for, and the rest of the message. Names are read off the front, one word at a time, until a word
 * isn't a member's name. Returns null if it isn't this kind of message (or the name isn't a member).
 */
export function parseDirected(trip: Trip, raw: string, verbs: RegExp): { target: Target; rest: string } | null {
  const m = raw.trim().match(new RegExp(`^(?:(?:can|could) you |pls |please )?(?:${verbs.source})\\s+(.+)$`, "i"));
  if (!m) return null;
  let rest = m[1].trim();
  const ev = rest.match(EVERYONE);
  if (ev) return { target: { kind: "everyone" }, rest: rest.slice(ev[0].length).replace(/^[\s,:-]+/, "").trim() };
  const phones: Phone[] = [];
  for (;;) {
    const word = rest.match(/^([A-Za-z'’]+)[\s,&]*/);
    if (!word) break;
    if (/^(and|n)$/i.test(word[1]) && phones.length) {
      rest = rest.slice(word[0].length);
      continue;
    }
    const member = findMember(trip, word[1]);
    if (!member) break;
    phones.push(member.phone);
    rest = rest.slice(word[0].length);
  }
  if (!phones.length) return null; // not a name we know: let the model read it
  return { target: { kind: "people", phones: [...new Set(phones)] }, rest: rest.trim() };
}

/** "if he can bring the tent" -> "can you bring the tent?"; "what snacks they want" -> "what snacks you want?" */
export function toYou(raw: string): string {
  let q = raw.trim().replace(/^(?:if|whether|about)\s+/i, "").replace(/[?!.\s]+$/, "");
  // "he can bring" -> "can you bring" (a statement turned back into the question it was)
  q = q.replace(/^(he|she|they)\s+(can|could|will|would|should|is|are|has|have|wants? to|needs? to)\b/i, (_m, _p, verb: string) => {
    const v = verb.toLowerCase();
    if (v === "is" || v === "are") return "are you";
    if (v === "has" || v === "have") return "have you";
    if (v.startsWith("want")) return "do you want to";
    if (v.startsWith("need")) return "do you need to";
    return `${v} you`;
  });
  q = youify(q.replace(/^(he|she)\s+(\w+)s\b/i, "do you $2")); // "she likes pizza" -> "do you like pizza"
  return q.length >= 3 ? `${q.slice(0, 140)}?` : "";
}

/** Talking about them -> talking to them: "he's on speaker duty" -> "you're on speaker duty". */
export function youify(text: string): string {
  return text
    .replace(/\b(he'?s|she'?s|they'?re)\b/gi, "you're").replace(/\b(is he|is she|are they)\b/gi, "are you")
    .replace(/\b(he|she|they) (has|have)\b/gi, "you have").replace(/\b(he|she|they) (was|were)\b/gi, "you were")
    .replace(/\b(he|she|they) (needs|wants|gets|brings|drives)\b/gi, (_m, _p, v: string) => `you ${v.slice(0, -1)}`)
    .replace(/\b(he|she|they)\b/gi, "you").replace(/\b(his|her|their)\b/gi, "your").replace(/\b(him|them)\b/gi, "you")
    .replace(/\b(himself|herself|themselves)\b/gi, "yourself");
}

/** "ask everyone if 10am saturday works??" -> "10am saturday works?" */
export function parsePollRequest(raw: string): string | null {
  const m = raw.trim().match(/^(?:(?:can|could) you |pls |please )?(?:ask|check with|poll)\s+(?:everyone|everybody|the group|all|people|the crew|y'?all|them all)\b[\s,:-]*(.+)$/i);
  return m ? toYou(m[1]) || null : null;
}

// ---------------------------------------------------------------- reaching people

/** People we can actually reach right now (shared pool: only those who've texted us). */
function reachable(trip: Trip, m: Member): boolean {
  if (m.phone === trip.organizer || m.optedOut || m.rsvp === "no" || !m.name) return false;
  return !((m.viaLink || m.invited) && !m.heardFrom);
}

/** Resolve a target to reachable members, telling the organizer about anyone we can't reach. Null = nothing to do. */
function recipients(ctx: Ctx, trip: Trip, target: Target, what: "ask" | "tell"): Member[] | null {
  if (target.kind === "unknown") {
    ctx.out(trip.organizer, { kind: "text", text: `who's ${target.names.join(" or ")}? i don't see them in ${trip.title}. try the name they joined with.` });
    return null;
  }
  if (target.kind === "everyone") {
    const people = Object.values(trip.members).filter((m) => reachable(trip, m));
    if (!people.length) {
      ctx.out(trip.organizer, { kind: "text", text: `nobody's joined yet, so there's no one to ${what}. share your link first!` });
      return null;
    }
    return people;
  }
  const people = target.phones.map((p) => trip.members[p]).filter(Boolean);
  for (const m of people.filter((x) => !reachable(trip, x))) {
    const why = m.optedOut ? "opted out of texts" : m.rsvp === "no" ? "isn't coming" : "hasn't texted me yet, so i can't reach them";
    ctx.out(trip.organizer, { kind: "text", text: `${m.name || "they"} ${why}.` });
  }
  const ok = people.filter((m) => reachable(trip, m));
  return ok.length ? ok : null;
}

const listWho = (ms: Member[], everyone: boolean) =>
  everyone && ms.length > 3 ? `all ${ms.length} people` : ms.length === 2 ? `${ms[0].name} and ${ms[1].name}` : ms.map((m) => m.name).join(", ");

// ---------------------------------------------------------------- asking

export function startPoll(ctx: Ctx, trip: Trip, question: string, target: Target = { kind: "everyone" }): void {
  const people = recipients(ctx, trip, target, "ask");
  if (!people) return;
  const poll: Poll = { id: newId("poll"), question, open: true, askedAt: ctx.now(), asked: people.map((m) => m.phone), answers: {}, reported: false };
  polls(trip).push(poll);
  for (const m of people) enqueueAsk(ctx, trip, m, "poll", null, poll.id); // waits behind anything they're already answering
  const everyone = target.kind === "everyone";
  const done = people.length === 1 ? `i'll let you know what ${people[0].name} says.`
    : everyone ? "i'll text you once everyone answers." : people.length === 2 ? "i'll text you once they've both answered." : "i'll text you once they've all answered.";
  ctx.out(trip.organizer, { kind: "text", text: `on it, asking ${listWho(people, everyone)}. ${done}` });
  ctx.log(trip, "asked", `${organizerName(trip)} asked ${everyone ? "everyone" : listWho(people, false)} a question`);
}

export function recordPollAnswer(ctx: Ctx, trip: Trip, m: Member, ask: Ask, answer: string): void {
  const poll = findPoll(trip, ask.pollId);
  ctx.out(m.phone, { kind: "poll_ack", organizer: organizerName(trip), question: poll?.question ?? "", answer });
  if (!poll || poll.reported) return;
  poll.answers[m.phone] = answer.trim().slice(0, 200);
  ctx.log(trip, "answered", `${m.name} answered ${organizerName(trip)}'s question`);
  reportPollIfDone(ctx, trip, poll);
}

/** Done when everyone asked has answered, dropped out, or gone quiet past the give-up time. */
export function reportPollIfDone(ctx: Ctx, trip: Trip, only?: Poll): void {
  for (const poll of only ? [only] : polls(trip)) {
    if (poll.reported) continue;
    const live = (p: Phone) => {
      const m = trip.members[p];
      if (!m || m.optedOut || m.rsvp === "no" || p in poll.answers) return false;
      return m.pendingAsk?.pollId === poll.id || m.askQueue.some((a) => a.pollId === poll.id);
    };
    if (poll.asked.some(live)) continue;
    poll.reported = true;
    const r = pollResults(trip, poll);
    ctx.out(trip.organizer, { kind: "poll_report", question: poll.question, open: true, answers: r.answers, silent: r.silent });
  }
}

export function pollResults(trip: Trip, poll: Poll): { answers: { name: string; answer: string }[]; silent: string[] } {
  const name = (p: Phone) => trip.members[p]?.name || "someone";
  const answers = poll.asked.filter((p) => p in poll.answers).map((p) => ({ name: name(p), answer: poll.answers[p] }));
  const silent = poll.asked
    .filter((p) => !(p in poll.answers) && !trip.members[p]?.optedOut && trip.members[p]?.rsvp !== "no")
    .map(name);
  return { answers, silent };
}

/** Plain summary, used by status and as the no-AI fallback. */
export function pollSummary(trip: Trip, poll: Poll): string {
  const { answers, silent } = pollResults(trip, poll);
  return summarizeAnswers(poll.question, true, answers, silent, poll.reported);
}

export function summarizeAnswers(question: string, _open: boolean, answers: { name: string; answer: string }[], silent: string[], done = true): string {
  const quiet = silent.length ? `${done ? "no answer from" : "waiting on"} ${silent.join(", ")}` : "";
  const lines = answers.map((a) => `${a.name}: ${a.answer}`);
  return `"${question}" ${[...lines, quiet].filter(Boolean).join("; ")}`;
}

// ---------------------------------------------------------------- telling

/** "announce: leaving at 9" -> the message (null if not an announcement). "tell X ..." is parseDirected. */
export function parseAnnouncement(raw: string): string | null {
  const m = raw.trim().match(/^announce\s*:?\s+(.+)$/i);
  return m && m[1].trim().length >= 3 ? m[1].trim().slice(0, 200) : null;
}

/** Send the organizer's note, clearly labeled as from them, to everyone or just the people they named. */
export function announce(ctx: Ctx, trip: Trip, message: string, target: Target = { kind: "everyone" }): void {
  const people = recipients(ctx, trip, target, "tell");
  if (!people) return;
  const org = organizerName(trip);
  for (const m of people) ctx.out(m.phone, { kind: "text", text: `from ${org}: ${message}` });
  const everyone = target.kind === "everyone";
  ctx.out(trip.organizer, { kind: "text", text: `sent to ${listWho(people, everyone)}.` });
  ctx.log(trip, "asked", `${org} sent ${everyone ? "everyone" : listWho(people, false)} a note`);
}

/** "to bring the speaker" -> "bring the speaker"; "know that we're leaving at 9" -> "we're leaving at 9". */
export function cleanNote(raw: string): string {
  return youify(raw.trim().replace(/^(?:know\s+)?(?:that\s+|to\s+)?/i, "").replace(/\s+/g, " ")).slice(0, 200);
}
