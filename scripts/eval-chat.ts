// Conversation eval: realistic texts run through the real model, each graded by code (right action, voice rules,
// no made-up facts, no privacy leaks). Run after every prompt/example change to see if it got better or worse.
// Usage: npm run eval            (needs ANTHROPIC_API_KEY or GEMINI_API_KEY in .env; ~100 small model calls)
//        npm run eval -- budget  (only cases whose name contains "budget")
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine/engine.js";
import { makeConverser, soundsLikeMeta } from "../src/llm/converse.js";
import { llmName, pickLlm } from "../src/llm/pick.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import type { Trip } from "../src/types.js";

const cfg = loadConfig({ requireSpectrum: false });
const llm = pickLlm(cfg, 10000);
if (!llm) {
  console.error("Set ANTHROPIC_API_KEY (or GEMINI_API_KEY + GEMINI_MODEL) in .env first.");
  process.exit(1);
}

const P = { Krish: "+19195550100", Sam: "+19195550101", Maya: "+19195550102", Leo: "+19195550103" } as const;
type Name = keyof typeof P;
const NAME_OF = Object.fromEntries(Object.entries(P).map(([n, p]) => [p, n])) as Record<string, Name>;
const SAM_BUDGET = 55;

interface Result {
  replies: string[]; // what the sender got back
  others: Partial<Record<Name, string[]>>; // what everyone else got
  trip: Trip;
  ms: number;
  firstMs: number | null; // when the sender's first reply went out (what they actually wait for)
}
interface Case {
  name: string;
  from: Name;
  text: string;
  started?: boolean; // trip already kicked off (rsvp/budget questions out)
  setup?: (trip: Trip) => void;
  check: (r: Result) => string | null; // null = pass, else why it failed
}

// ---------------------------------------------------------------- helpers for checks
const all = (r: Result) => r.replies.join(" | ");
const has = (r: Result, re: RegExp, why: string) => (re.test(all(r)) ? null : why);
const lacks = (r: Result, re: RegExp, why: string) => (re.test(all(r)) ? why : null);
const first = (...checks: (string | null)[]) => checks.find((c) => c) ?? null;
const orgNotified = (r: Result) => (r.others.Krish?.length ? null : "organizer wasn't told");
const nobodyElse = (r: Result) => {
  const leaked = (Object.keys(r.others) as Name[]).filter((n) => n !== "Krish" && r.others[n]?.length);
  return leaked.length ? `others were texted: ${leaked.join(", ")}` : null;
};

const CASES: Case[] = [
  // organizer: plain-English requests become the right action
  { name: "org asks who's coming", from: "Krish", text: "whos coming so far", check: (r) => has(r, /Sam/, "didn't name anyone") },
  { name: "org pushes date", from: "Krish", text: "can we push it to next weekend instead", check: (r) => (/next weekend/i.test(r.trip.dateText ?? "") ? null : `date is ${r.trip.dateText}`) },
  { name: "org poll", from: "Krish", text: "does sunday morning work for everyone?", check: (r) => (r.trip.polls?.length ? null : "no question sent") },
  { name: "org open poll", from: "Krish", text: "figure out when everyone's free this week", check: (r) => (r.trip.polls?.length ? null : "no question sent") },
  { name: "org open poll not suffixed", from: "Krish", text: "ask everyone what snacks they want", check: (r) => (r.others.Sam?.some((t) => /yes, no, or maybe/i.test(t)) ? "open question got yes/no/maybe" : r.trip.polls?.length ? null : "no poll") },
  // organizer: just one or a few people
  { name: "org asks just Sam", from: "Krish", text: "can u check if sam can bring the tent",
    check: (r) => first(r.others.Sam?.some((t) => /tent/i.test(t)) ? null : "Sam wasn't asked", r.others.Maya || r.others.Leo ? "others were asked too" : null) },
  { name: "org asks two people", from: "Krish", text: "ask maya and leo what time they get off work",
    check: (r) => first(r.others.Maya?.length && r.others.Leo?.length ? null : "Maya and Leo not both asked", r.others.Sam ? "Sam was asked too" : null) },
  { name: "org tells just Leo", from: "Krish", text: "let leo know hes on speaker duty",
    check: (r) => first(r.others.Leo?.some((t) => /speaker/i.test(t)) ? null : "Leo didn't get it", r.others.Sam || r.others.Maya ? "others got it too" : null) },
  { name: "org names unknown person", from: "Krish", text: "ask jake if he's coming",
    check: (r) => first(has(r, /Jake/i, "didn't ask who Jake is"), nobodyElse(r)) },
  { name: "org announcement", from: "Krish", text: "tell everyone to bring sunscreen", check: (r) => (r.others.Sam?.some((t) => /sunscreen/i.test(t)) ? null : "Sam didn't get the note") },
  { name: "org adds items", from: "Krish", text: "we need a cooler and a speaker", check: (r) => (r.trip.needs.some((n) => n.label.includes("cooler")) ? null : "cooler not added") },
  { name: "org kicks off", from: "Krish", text: "ok everyone's here, let's goooo", check: (r) => (r.trip.status !== "collecting_members" ? null : "trip not started") },
  { name: "org asks member budget", from: "Krish", text: "whats sam's budget", check: (r) => lacks(r, new RegExp(`\\b${SAM_BUDGET}\\b`), "leaked Sam's budget") },
  { name: "org cancel (unsupported)", from: "Krish", text: "cancel the whole thing", check: (r) => first(lacks(r, /\b(cancel+ed|done, it's cancel)/i, "claimed it cancelled"), nobodyElse(r)) },
  { name: "org small talk", from: "Krish", text: "lol this is gonna be so fun", check: (r) => (r.replies.length === 1 ? null : `${r.replies.length} replies`) },
  { name: "org common time", from: "Krish", text: "so what day works for everyone",
    setup: (t) => { t.polls = [{ id: "p1", question: "which days are you free?", open: true, askedAt: 0, asked: [P.Sam, P.Maya, P.Leo], answers: { [P.Sam]: "sat or sun", [P.Maya]: "only sunday", [P.Leo]: "sunday after 12" }, reported: true }]; },
    check: (r) => has(r, /sun/i, "didn't pick sunday") },
  { name: "org status reads like a text", from: "Krish", text: "status", started: true, check: (r) => lacks(r, /\d+\/\d+/, "stats-style x/y numbers") },
  { name: "poll answer gets a real reaction", from: "Sam", text: "sat works but i have work till 3",
    setup: (t) => { t.polls = [{ id: "p2", question: "which days this weekend work for you?", open: true, askedAt: 0, asked: [P.Sam, P.Maya, P.Leo], answers: {}, reported: false }];
      t.members[P.Sam].pendingAsk = { id: "a2", topic: "poll", needId: null, pollId: "p2", askedAt: 1, nudged: false }; },
    check: (r) => first(r.trip.polls?.[0]?.answers[P.Sam] ? null : "answer not saved", has(r, /3|sat/i, "didn't react to what they said")) },
  // members: answered from facts, or passed to the organizer, never invented
  { name: "member who's going", from: "Sam", text: "who else is going", check: (r) => has(r, /Maya|Leo|Krish/, "didn't name anyone") },
  { name: "member date", from: "Sam", text: "wait when is it again", check: (r) => has(r, /saturday/i, "didn't say saturday") },
  { name: "member cost (unknown)", from: "Sam", text: "how much is this gonna cost", check: (r) => first(orgNotified(r), lacks(r, /\$\d/, "made up a price")) },
  { name: "member plus-one", from: "Maya", text: "can i bring my bf", check: (r) => (r.others.Krish?.some((t) => /Maya asked: .*(bf|boyfriend)/i.test(t)) ? null : `organizer got: ${r.others.Krish}`) },
  { name: "member location (unknown)", from: "Leo", text: "where are we even going lol", check: (r) => first(orgNotified(r), lacks(r, /\b(beach|lake|park) (in|at|near)\b/i, "invented a place")) },
  { name: "member asks other budget", from: "Maya", text: "whats sam's budget", check: (r) => lacks(r, new RegExp(`\\b${SAM_BUDGET}\\b`), "leaked Sam's budget") },
  { name: "member late", from: "Sam", text: "i might be like 30 min late", check: (r) => (r.others.Krish?.some((t) => /heads up from Sam: .*late/i.test(t)) ? null : `organizer got: ${r.others.Krish}`) },
  { name: "member budget stays private", from: "Sam", text: "can we keep it cheap? i can only do like 55 max", check: (r) => (r.others.Krish?.some((t) => /55|\$/.test(t)) ? "budget relayed to organizer" : null) },
  { name: "member is this a bot", from: "Leo", text: "is this a bot", check: (r) => has(r, /\bAI\b/i, "didn't say it's an AI") },
  { name: "member lmao", from: "Maya", text: "lmaooo", check: (r) => (r.replies.join("").length <= 40 ? null : "too long for 'lmaooo'") },
  { name: "member thanks", from: "Sam", text: "thank uuu", check: (r) => (r.replies.join("").length <= 60 ? null : "too long for a thanks") },
  { name: "member tries organizer action", from: "Sam", text: "move it to monday", check: (r) => first(r.trip.dateText === "saturday" ? null : "member changed the date", nobodyElse(r)) },
  { name: "member tries announcement", from: "Maya", text: "tell everyone to bring snacks", check: (r) => nobodyElse(r) },
  // answers to open questions from the bot
  { name: "rsvp slang yes", from: "Sam", text: "bet im down", started: true, check: (r) => (r.trip.members[P.Sam].rsvp === "yes" ? null : `rsvp ${r.trip.members[P.Sam].rsvp}`) },
  { name: "rsvp with question", from: "Maya", text: "depends who's going", started: true, check: (r) => first(has(r, /Sam|Leo|Krish/, "didn't say who's going"), r.trip.members[P.Maya].rsvp === "unknown" ? null : "guessed an rsvp") },
  { name: "rsvp no + reason", from: "Leo", text: "nah cant this weekend, family stuff", started: true, check: (r) => (r.trip.members[P.Leo].rsvp === "no" ? null : `rsvp ${r.trip.members[P.Leo].rsvp}`) },
  { name: "rsvp yes cant drive", from: "Sam", text: "yes! but i cant drive", started: true, check: (r) => (r.trip.members[P.Sam].rsvp === "yes" && !r.trip.members[P.Sam].carHint ? null : "missed yes / car") },
  { name: "budget words", from: "Maya", text: "idk like forty bucks?", started: true,
    setup: (t) => { t.members[P.Maya].rsvp = "yes"; t.members[P.Maya].pendingAsk = { id: "a1", topic: "budget", needId: null, askedAt: 1, nudged: false }; },
    check: (r) => (r.trip.members[P.Maya].budgetCap === 40 ? null : `budget ${r.trip.members[P.Maya].budgetCap}`) },
  // from the team's 500 reference conversations (human_conversations_500.jsonl)
  { name: "ref: yes with a catch", from: "Leo", text: "yeah as long as were back by 8", started: true,
    check: (r) => first(r.trip.members[P.Leo].rsvp === "yes" ? null : `rsvp ${r.trip.members[P.Leo].rsvp}`, r.others.Krish?.some((t) => /back by 8/.test(t)) ? null : "organizer didn't hear the catch") },
  { name: "ref: fine but", from: "Maya", text: "fine but im not waking up before 9", started: true,
    check: (r) => (r.trip.members[P.Maya].rsvp === "yes" ? null : `rsvp ${r.trip.members[P.Maya].rsvp}`) },
  { name: "ref: check calendar", from: "Sam", text: "lemme check my calendar", started: true,
    check: (r) => (r.replies.join(" ").length <= 60 ? null : "too long for 'lemme check'") },
  { name: "ref: budget 10 skull", from: "Maya", text: "10 💀", started: true,
    setup: (t) => { t.members[P.Maya].rsvp = "yes"; t.members[P.Maya].pendingAsk = { id: "a3", topic: "budget", needId: null, askedAt: 1, nudged: false }; },
    check: (r) => (r.trip.members[P.Maya].budgetCap === 10 ? null : `budget ${r.trip.members[P.Maya].budgetCap}`) },
  { name: "ref: reluctant driver", from: "Sam", text: "id rather not but i can if no one else does", started: true,
    setup: (t) => {
      t.members[P.Sam].rsvp = "yes";
      t.needs.push({ id: "n1", kind: "seats", label: "seats", quantityNeeded: 3, quantityFilled: 0, candidates: [], asked: [P.Sam], declined: [], providers: [], status: "open", waitingOn: P.Sam, shortNotified: null });
      t.members[P.Sam].pendingAsk = { id: "a4", topic: "drive", needId: "n1", askedAt: 1, nudged: false };
    },
    check: (r) => has(r, /backup/i, "didn't make them the backup") },
  { name: "ref: bad news", from: "Leo", text: "hey so bad news", started: true,
    setup: (t) => { t.members[P.Leo].rsvp = "yes"; t.members[P.Leo].pendingAsk = null; },
    check: (r) => first(r.replies.join(" ").length <= 60 ? null : "too long", r.trip.members[P.Leo].rsvp === "yes" ? null : "dropped them too early") },
  { name: "ref: rain", from: "Sam", text: "is it gonna rain", check: (r) => lacks(r, /\b(sunny|clear skies|\d+%|degrees|forecast says)\b/i, "made up a forecast") },
  { name: "ref: thanks for organizing", from: "Maya", text: "thanks for organizing btw", check: (r) => has(r, /Krish/, "didn't credit the organizer") },
  { name: "ref: take me off", from: "Leo", text: "take me off the list pls", started: true,
    setup: (t) => { t.members[P.Leo].rsvp = "yes"; t.members[P.Leo].pendingAsk = null; },
    check: (r) => (r.trip.members[P.Leo].rsvp === "no" || r.trip.members[P.Leo].optedOut ? null : "still on the list") },
  { name: "drop out", from: "Leo", text: "ugh something came up, i can't come anymore sorry", started: true,
    setup: (t) => { t.members[P.Leo].rsvp = "yes"; t.members[P.Leo].pendingAsk = null; },
    check: (r) => (r.trip.members[P.Leo].rsvp === "no" ? null : "not dropped") },
];

// ---------------------------------------------------------------- running
const quiet = { nudgeAfterMs: 1e9, giveUpAfterMs: 2e9, demoMode: true };

/** A fresh trip: Krish organizes Beach day (saturday), Sam/Maya/Leo joined and texted in. Built without the model. */
async function baseTrip(started: boolean) {
  const store = new Store(null);
  const plain = new Engine({ store, transport: new FakeTransport(), understand: makeUnderstander(null), phrase: makePhraser(null), cfg: quiet });
  const code = await plain.createTripFromWeb({ title: "Beach day", dateText: "saturday", name: "Krish", phone: P.Krish });
  await plain.handleInbound(P.Krish, "hi Roundup! i'm Krish, planning Beach day");
  for (const n of ["Sam", "Maya", "Leo"] as const) {
    await plain.joinFromWeb(code, { name: n, phone: P[n] });
    await plain.handleInbound(P[n], `hi! i'm ${n}, joining Beach day (${code})`);
  }
  const trip = Object.values(store.state.trips)[0];
  trip.members[P.Sam].budgetCap = SAM_BUDGET; // private: must never show up for anyone else
  if (started) await plain.handleInbound(P.Krish, "start");
  return { store, trip };
}

async function runCase(c: Case): Promise<{ c: Case; fail: string | null; r: Result }> {
  const { store, trip } = await baseTrip(!!c.started);
  c.setup?.(trip);
  const transport = new FakeTransport();
  const engine = new Engine({
    store, transport, understand: makeUnderstander(llm), phrase: makePhraser(llm), cfg: quiet, converse: makeConverser(llm),
  });
  const t0 = Date.now();
  let firstMs: number | null = null;
  transport.onSend = (m) => { if (m.phone === P[c.from] && firstMs === null) firstMs = Date.now() - t0; };
  await engine.handleInbound(P[c.from], c.text);
  const ms = Date.now() - t0;
  const others: Result["others"] = {};
  for (const m of transport.sent) if (m.phone !== P[c.from]) (others[NAME_OF[m.phone]] ??= []).push(m.text);
  const r: Result = { replies: transport.to(P[c.from]), others, trip: Object.values(store.state.trips)[0], ms, firstMs };
  return { c, fail: c.check(r) ?? voiceIssues(r) ?? leakIssues(r, c.from), r };
}

/** Rules every reply must follow (spec section 8 voice). */
function voiceIssues(r: Result): string | null {
  for (const t of [...r.replies, ...Object.values(r.others).flat()]) {
    if (/yes, no,? or maybe|yes or no works|just a number|a number like/i.test(t ?? "")) return `form-style wording: "${t}"`;
    if (soundsLikeMeta(t ?? "", "\"")) return `model talked about its own writing: "${t}"`;
  }
  for (const t of r.replies) {
    if (t.length > 330) return `too long (${t.length})`;
    if ((t.match(/\?/g) ?? []).length > 1) return `more than one question: "${t}"`;
    if (/!/.test(t) && !/\bAI\b/.test(t)) return `exclamation mark (reference style has none): "${t}"`;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) return `emoji (reference style has none): "${t}"`;
    if (/\b(krish|sam|maya|leo)\b/.test(t)) return `lowercase name: "${t}"`;
    if (/great question|as an ai language model|i'm just an ai/i.test(t)) return `robotic phrase: "${t}"`;
  }
  return r.replies.length ? null : "no reply at all";
}

/** Sam's budget may only ever go to Sam. */
function leakIssues(r: Result, from: Name): string | null {
  for (const [n, texts] of Object.entries(r.others)) {
    if (n !== "Sam" && texts?.some((t) => new RegExp(`\\b${SAM_BUDGET}\\b`).test(t))) return `Sam's budget sent to ${n}`;
  }
  return from !== "Sam" && new RegExp(`\\b${SAM_BUDGET}\\b`).test(all(r)) ? "Sam's budget in reply" : null;
}

const filter = process.argv[2]?.toLowerCase();
const cases = CASES.filter((c) => !filter || c.name.toLowerCase().includes(filter));
console.log(`model: ${llmName(cfg)}   cases: ${cases.length}\n`);
const results: Awaited<ReturnType<typeof runCase>>[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...(await Promise.all(cases.slice(i, i + 4).map(runCase))));

for (const { c, fail, r } of results) {
  console.log(`${fail ? "FAIL" : "pass"}  ${c.name.padEnd(30)} reply ${String(r.firstMs ?? "-").padStart(5)} ms   <- ${c.from}: ${c.text}`);
  for (const t of r.replies) console.log(`        -> ${t}`);
  for (const [n, texts] of Object.entries(r.others)) for (const t of texts ?? []) console.log(`        -> (${n}) ${t}`);
  if (fail) console.log(`        !! ${fail}`);
}
const passed = results.filter((x) => !x.fail).length;
const times = results.map((x) => x.r.firstMs ?? x.r.ms).sort((a, b) => a - b);
const slow = times.filter((t) => t > 4000).length;
const lens = results.flatMap((x) => x.r.replies.map((t) => t.length)).sort((a, b) => a - b);
console.log(`reply length: median ${lens[Math.floor(lens.length / 2)]} chars (reference set: 31), p90 ${lens[Math.floor(lens.length * 0.9)]} (reference: 49)`);
console.log(`\n${passed}/${results.length} passed   reply time: median ${times[Math.floor(times.length / 2)]} ms, slowest ${times.at(-1)} ms, ${slow} over 4 s`);
