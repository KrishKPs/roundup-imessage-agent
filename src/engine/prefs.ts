// The planning conversation (plan.md A + B): a short setup interview with the organizer, and two optional
// preference questions for each member. Code reads the answers into fixed fields and tags; the itinerary step
// only ever sees counts for members' constraints (they're private, like budgets).
import type { InterviewStep, Member, MemberPrefs, Trip } from "../types.js";
import { clip } from "../util.js";
import { enqueueAsk } from "./asks.js";
import { type Ctx, goingMembers, isGoing, organizerName } from "./context.js";

export const STEPS: InterviewStep[] = ["where", "times", "vibe", "mustDo", "avoid", "pace"];

const ASK: Record<InterviewStep, string[]> = {
  where: ["where are you all headed?", "where's the trip, roughly?", "where are we going?"],
  times: ["what time do you want to leave, and be back by?", "rough times? when to leave and when to be back", "when should everyone leave, and be home by?"],
  vibe: ["what's the vibe: chill, active, or food-focused?", "chill day, active day, or all about the food?", "vibe check: chill, active, or food?"],
  mustDo: ["anything that has to happen on this trip?", "any must-dos?", "anything you'd be bummed to skip?"],
  avoid: ["anything to skip or avoid?", "anything people should avoid?", "anything off the table?"],
  pace: ["want me to pack the day or leave breathing room?", "packed day or some free time?", "fill the day up, or keep it loose?"],
};
const INTEREST = ["what are you most hoping to do?", "what would make the day for you?", "anything you really want to do on this one?"];
const CONSTRAINT = ["anything i should plan around? food needs, can't do long walks, need to leave early", "anything to plan around, like food needs or leaving early?", "any food needs or timing stuff i should know?"];
const pick = (list: string[], seed: string) => list[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % list.length];

/** Steps the create page (or an earlier answer) already covered are skipped. */
function answered(trip: Trip, step: InterviewStep): boolean {
  const f = trip.facts ?? {}, p = trip.prefs ?? {};
  if (step === "where") return !!(f.where || trip.place);
  if (step === "times") return !!(f.leaveAt && f.backBy);
  if (step === "vibe") return !!p.vibe;
  if (step === "mustDo") return !!p.mustDo;
  if (step === "avoid") return !!p.avoid;
  return !!p.pace;
}

/** Queue the setup questions for the organizer (once). One at a time, through the normal pending-question queue. */
export function startInterview(ctx: Ctx, trip: Trip): void {
  trip.prefs ??= {};
  if (trip.prefs.interviewStarted) return;
  trip.prefs.interviewStarted = true;
  const org = trip.members[trip.organizer];
  if (!org) return;
  const todo = STEPS.filter((s) => !answered(trip, s));
  if (!todo.length) return finishInterview(ctx, trip);
  for (const step of todo) enqueueAsk(ctx, trip, org, "interview", null, undefined, step);
}

export function interviewQuestion(trip: Trip, step: InterviewStep): string {
  const q = pick(ASK[step], trip.code + step);
  if (trip.prefs?.introSent) return q;
  (trip.prefs ??= {}).introSent = true; // the first question explains itself once
  return clip(`quick setup so i can plan the day, say skip anytime. ${q}`);
}

const SKIP = /^(skip|pass|next|idk|dunno|not sure|no idea|whatever|n\/a)\b/i;
const DONE = /^(done|that'?s it|that'?s all|stop asking|enough|we'?re good)\b/i;
const NONE = /^(no|nah|nope|nothing|none|not really|all good|nah we'?re good|idc)\b/i;

/**
 * Apply one interview answer. "next" / "done" (the organizer wants to stop) / "other" (doesn't look like an answer
 * to this question, e.g. small talk during the where-question: the normal conversation handles it instead).
 */
export function interviewAnswer(trip: Trip, step: InterviewStep, raw: string): "next" | "done" | "other" {
  const text = raw.trim();
  if (DONE.test(text)) return "done";
  if (SKIP.test(text)) return "next";
  const lower = text.toLowerCase();
  // Questions, requests and chit-chat are never setup answers ("whos coming so far", "so what day works", "let's go").
  const lead = lower.replace(/^((so|ok|okay|wait|hey|yo|alright|and|but|also|lol)[,!.\s]+)+/, "");
  if (/\?\s*$/.test(lower) || /^(who|whos|who's|what|whats|what's|when|where|why|how|hows|is|are|did|does|do|can|could|will|would|should|any(one|body)|ask|tell|let'?s|start|send)\b/.test(lead)) return "other";
  if (/\b(lol|lmao|haha|omg|thanks|thank you|ty|everyone'?s (here|in)|kick (it )?off|let'?s go)/.test(lower)) return "other";
  if (step === "where" && (text.split(/\s+/).length > 5 || /\b(i|we|you|it|this|that|gonna|is|are)\b/.test(lead) && !/^(we'?re |we are )?(going to|headed to|heading to)\b/.test(lead))) return "other";
  if (step === "times" && !/\d|noon|midnight|sunrise|sunset|morning|evening/.test(lower)) return "other";
  if (step === "vibe" && text.split(/\s+/).length > 6 && !/\b(chill|relax|active|adventur|food|eat)/.test(lower)) return "other";
  if (step === "pace" && !/\b(pack|full|busy|lots|max|cram|relax|breath|chill|free|loose|easy|room)/.test(lower)) return "other";
  trip.prefs ??= {};
  trip.facts ??= {};
  const t = text.toLowerCase();
  if (step === "where") {
    const where = text.replace(/^(we'?re |we are )?(going to|headed to|heading to|to)\s+/i, "").replace(/[.!]+$/, "").slice(0, 60);
    trip.facts.where = where;
    trip.place = where;
  } else if (step === "times") {
    const times = t.match(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)?\b|\b(?:noon|midnight|sunrise|sunset)\b/g) ?? [];
    if (times[0]) trip.facts.leaveAt = times[0].replace(/\s+/g, "");
    if (times[1]) trip.facts.backBy = times[1].replace(/\s+/g, "");
  } else if (step === "vibe") {
    trip.prefs.vibe = /\bchill|relax|lazy|easy\b/.test(t) ? "chill" : /\bactiv|adventur|hike|sport|move\b/.test(t) ? "active"
      : /\bfood|eat|restaurant|foodie\b/.test(t) ? "food-focused" : text.slice(0, 40);
  } else if (step === "mustDo" || step === "avoid") {
    trip.prefs[step] = NONE.test(t) ? [] : text.split(/,|\band\b|;/).map((s) => s.trim()).filter(Boolean).slice(0, 5).map((s) => s.slice(0, 50));
  } else if (step === "pace") {
    trip.prefs.pace = /\b(pack|full|busy|lots|max|cram)\b/.test(t) ? "packed" : "relaxed";
  }
  return "next";
}

/** The one-text recap after the last question (or "done"). */
export function finishInterview(ctx: Ctx, trip: Trip): void {
  trip.prefs ??= {};
  if (trip.prefs.interviewDone) return;
  trip.prefs.interviewDone = true;
  const org = trip.members[trip.organizer];
  if (org) {
    org.askQueue = org.askQueue.filter((a) => a.topic !== "interview");
    if (org.pendingAsk?.topic === "interview") org.pendingAsk = null;
  }
  const f = trip.facts ?? {}, p = trip.prefs;
  const bits = [f.where || trip.place, f.leaveAt && f.backBy ? `${f.leaveAt}-${f.backBy}` : f.leaveAt, p.vibe, p.pace === "relaxed" ? "with breathing room" : p.pace === "packed" ? "packed" : null].filter(Boolean);
  ctx.out(trip.organizer, { kind: "text", text: clip(`got it${bits.length ? `: ${bits.join(", ")}` : ""}. i'll ask everyone what they're into and draft a plan for you to approve`) });
  ctx.log(trip, "answered", `${organizerName(trip)} finished the trip setup`);
}

// ---------------------------------------------------------------- member preferences (B)

/** Queue the two preference questions for a member who's in, after their other questions. Skipped if they seem annoyed. */
export function maybeAskPrefs(ctx: Ctx, trip: Trip, m: Member): void {
  if (m.prefsAsked || m.optedOut) return;
  if (m.phone === trip.organizer || !isGoing(m) || trip.status === "collecting_members") return;
  if (m.unclearCount > 0) return; // short or annoyed: don't add more questions
  // Logistics first: never get in the way of the rides/items chains (a "yes 4 seats" must not land here).
  if (trip.needs.some((n) => n.status === "open")) return;
  if (trip.settings?.rides !== false && !trip.needs.some((n) => n.kind === "seats")) return;
  m.prefsAsked = true;
  enqueueAsk(ctx, trip, m, "interest");
  enqueueAsk(ctx, trip, m, "constraint");
}

export function interestQuestion(m: Member): string {
  return pick(INTEREST, m.phone + "i");
}
export function constraintQuestion(m: Member): string {
  return clip(`${pick(CONSTRAINT, m.phone + "c")} (only i see this)`);
}

const TAGS: [string, RegExp][] = [
  ["food", /\b(food|eat|eating|restaurant|lunch|dinner|bbq|grill|snack|taco|pizza|ice cream)/],
  ["swimming", /\b(swim|swimming|beach|water|lake|pool|surf)/],
  ["hiking", /\b(hike|hiking|trail|walk|climb)/],
  ["views", /\b(view|views|sunset|sunrise|scenic|lookout|overlook)/],
  ["games", /\b(game|games|cards|frisbee|volleyball|spikeball)/],
  ["shopping", /\b(shop|shopping|thrift|market|mall)/],
  ["nightlife", /\b(bar|bars|club|party|night ?life|drinks)/],
  ["photos", /\b(photo|photos|pics|pictures|camera)/],
  ["relaxing", /\b(relax|chill|nap|lay|lie|read|tan)/],
  ["sports", /\b(sport|sports|soccer|football|basketball|kayak|bike|ski)/],
  ["music", /\b(music|concert|speaker|playlist|dj)/],
];

export function readInterests(text: string): MemberPrefs {
  const t = text.toLowerCase();
  if (NONE.test(t) || /^(idc|anything|whatever|up to you|dont care|don'?t care)\b/.test(t)) return { interests: [], interestNote: "" };
  const tags = TAGS.filter(([, re]) => re.test(t)).map(([tag]) => tag);
  return { interests: tags.length ? tags : ["other"], interestNote: text.trim().slice(0, 100) };
}

const DIET = /\b(vegetarian|vegan|gluten|celiac|allerg|halal|kosher|dairy|lactose|nut|peanut|pescatarian|shellfish)/;
const MOBILITY = /\b(walk|walking|knee|ankle|wheelchair|crutches|mobility|stairs|hike|hiking|tired easily)/;
const TIMING = /\b(early|late|leave by|leave at|back by|work|shift|class|by \d|after \d|before \d|curfew)/;

export function readConstraints(text: string): MemberPrefs {
  const t = text.toLowerCase();
  if (NONE.test(t)) return { constraints: [], constraintNote: "" };
  const c = [DIET.test(t) && "dietary", MOBILITY.test(t) && "mobility", TIMING.test(t) && "timing"].filter(Boolean) as string[];
  return { constraints: c.length ? c : ["other"], constraintNote: text.trim().slice(0, 100) };
}

/** Counts only, never names: "food 3, views 2" and "2 vegetarian, 1 needs short walks". */
export function prefCounts(trip: Trip): { interests: string; constraints: string; answered: number; going: number } {
  const going = goingMembers(trip).filter((m) => m.phone !== trip.organizer);
  const tally = new Map<string, number>();
  for (const m of going) for (const tag of m.prefs?.interests ?? []) if (tag !== "other") tally.set(tag, (tally.get(tag) ?? 0) + 1);
  const interests = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  const words = new Map<string, number>();
  for (const m of going) {
    const note = (m.prefs?.constraintNote ?? "").toLowerCase();
    const label = /vegan/.test(note) ? "vegan" : /vegetarian/.test(note) ? "vegetarian" : /gluten|celiac/.test(note) ? "gluten-free"
      : /nut|peanut/.test(note) ? "nut allergy" : /allerg/.test(note) ? "food allergy" : /halal/.test(note) ? "halal" : /kosher/.test(note) ? "kosher"
      : (m.prefs?.constraints ?? []).includes("mobility") ? "needs short walks" : (m.prefs?.constraints ?? []).includes("timing") ? "has a timing limit" : null;
    if (label) words.set(label, (words.get(label) ?? 0) + 1);
  }
  const constraints = [...words.entries()].map(([k, v]) => `${v} ${k}`).join(", ");
  return { interests, constraints, answered: going.filter((m) => m.prefs?.interests).length, going: going.length };
}
