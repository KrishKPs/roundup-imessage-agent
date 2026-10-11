// Turns a MessageIntent into one short text. Every intent has a fixed template;
// a few casual ones may be reworded by Gemini, with the template as the fallback.
import type { AskTopic, MessageIntent } from "../types.js";
import { summarizeAnswers } from "../engine/poll.js";
import { clip, joinLink, listNames } from "../util.js";
import type { Llm } from "./gemini.js";
import { PHRASE_SYSTEM, phrasePrompt } from "./prompts.js";
import { soundsLikeMeta } from "./converse.js";

export type Phraser = (intent: MessageIntent, history?: { from: "them" | "bot"; text: string }[]) => Promise<string>;

const SIMPLE_QUESTION: Record<AskTopic, string> = {
  name: "what's your first name?",
  rsvp: "you coming?",
  budget: "roughly what's the most you'd wanna spend? fine to skip it",
  drive: "can you drive?",
  seats: "how many seats in your car, counting you?",
  item: "can you bring it?",
  poll: "what do you think?",
  interview: "say skip if you'd rather not",
  interest: "anything you're hoping to do? or idc works",
  constraint: "anything i should plan around? nah works too",
};

/** The fixed wording for every intent. Used directly, or as the draft for Gemini. */
export function template(i: MessageIntent): string {
  switch (i.kind) {
    case "text": return i.text;
    case "ask_name_member": return `hey, i'm Roundup, an AI helping ${i.organizer} plan ${i.trip}. what's your first name?`;
    case "ask_name_organizer": return "hey, i'm Roundup, an AI that plans group trips over text so the group chat doesn't have to. what's your first name?";
    case "intro": return `hey ${i.name}, i'm Roundup, an AI helping ${i.organizer} plan ${i.trip}. i'll ask a few quick things here so the group chat stays quiet. reply stop anytime.`;
    case "trip_created":
      return i.joinByLink
        ? `nice to meet you ${i.name}. ${i.trip} is set up, code ${i.code}. paste the next text in your group chat, then text start when everyone's in.`
        : `nice to meet you ${i.name}. ${i.trip} is set up. who's coming? type their names and numbers here, like: Sam 704 555 1234 (or share contacts from the Contacts app)`;
    case "invite_line":
      return i.agentNumber
        ? `${i.organizer} is planning ${i.trip}! tap to join: ${joinLink(i.agentNumber, i.code)} (or text "join ${i.code}" to ${i.agentNumber}). Roundup, an AI, sorts out the details with you 1:1.`
        : `${i.organizer} is planning ${i.trip}! text "join ${i.code}" to this number and Roundup will sort out the details with you 1:1.`;
    case "ask_rsvp": return `you in for ${i.trip}${i.date ? ` on ${i.date}` : ""}?`;
    case "ask_budget": return "what's the most you'd wanna spend? nobody sees it but me";
    case "ask_drive": return `any chance you can drive for ${i.trip}?`;
    case "ask_seats": return "appreciate that. how many seats, counting you?";
    case "ask_item": return `could you bring a ${i.item}?`;
    case "reask": return `sorry, didn't catch that. ${i.question ?? SIMPLE_QUESTION[i.topic].replace("it?", i.item ? `a ${i.item}?` : "it?")}`;
    case "nudge": return `hey ${i.name}, no rush. ${i.question ?? SIMPLE_QUESTION[i.topic].replace("it?", i.item ? `a ${i.item}?` : "it?")}`;
    case "ack": return ackText(i.topic, i.value);
    case "handoff_member": return `no worries, i'll have ${i.organizer} follow up with you.`;
    case "handoff_organizer": return `heads up: i couldn't get a clear answer from ${i.name} about ${topicLabel(i.topic, i.item)}. can you check with them?`;
    case "question_answer": {
      const what = `${i.organizer}'s planning ${i.trip}${i.date ? ` (${i.date})` : ""}.`;
      const next = i.collecting
        ? ` i'll text you a few quick things once it kicks off.`
        : " i'm sorting rides and who brings what, then i'll text you your plan.";
      return `${what}${next}${i.flagged ? ` i've asked ${i.organizer} about the rest.` : ""}`;
    }
    case "question_organizer":
      if (i.note && i.fyi) return `heads up from ${i.name}: ${i.note}`;
      if (i.note) return `${i.name} asked: ${i.note} text them back when you get a sec.`;
      return `${i.name} has a question about the trip that i couldn't answer. can you text them?`;
    case "drop_ack": return "all good, it happens. i'll take you off the list.";
    case "organizer_drop": return `heads up: ${i.name} can't come anymore. i'm reworking the plan.`;
    case "short_organizer": return `heads up: we're ${i.missing} ${i.unit} short for ${i.label} and i've asked everyone who could help. any ideas?`;
    case "stop_confirm": return "got it, you won't hear from me again. take care";
    case "unknown_code": return "hmm, i don't know that code. can you double-check it with whoever invited you?";
    case "help": return "hey, i'm Roundup, an AI that plans group trips over text. planning something? tell me what and when, like \"camping trip saturday\". got a code? just send it.";
    case "already_member": return `you're already in ${i.trip}`;
    case "waiting_for_start": return `you're in${i.trip ? ` for ${i.trip}` : ""}. i'll text you once ${i.organizer} kicks things off.`;
    case "started_organizer": return `we're rolling. i'm texting ${i.count === 1 ? "them" : i.count === 2 ? "both of them" : `all ${i.count} people`} now. text status anytime.`;
    case "needs_added": return `added: ${i.items.join(", ")}. i'll find people to bring them.`;
    case "not_organizer": return `only ${i.organizer} can do that one.`;
    case "late_ack": return "got it, thanks";
    case "noted_car": return "good to know, i'll keep that in mind";
    case "all_set": return "all set. i'll only text again with the final plan";
    case "invited": return `hey${i.name ? ` ${i.name}` : ""},${i.again ? " (sending again in case this got lost)" : ""} ${i.organizer} added you to ${i.trip}${i.date ? ` (${i.date})` : ""}. i'm Roundup, an AI helping plan it 1:1 so the group chat stays quiet. reply stop anytime.`;
    case "people_added": return `added ${listNames(i.names)}, texting them now${i.skipped ? ` (skipped ${i.skipped} already in or opted out)` : ""}. ${i.started ? "they'll get the questions now." : "send more anytime, or say start when everyone's in."}`;
    case "ask_what_planning": return "hey, i'm Roundup, an AI that plans group trips over text. what are you planning, and when? anything works. got a code from a friend? just send it.";
    case "organizer_ready": return `hey ${i.name}, i'm Roundup, an AI planning ${i.trip} with you. share your link in the group chat, then text start when everyone's in.`;
    case "ask_poll": return `${i.organizer} wanted to ask you: ${i.question}`;
    case "poll_ack": return `got it, i'll let ${i.organizer} know`;
    case "status_report": return i.text;
    case "poll_report": return summarizeAnswers(i.question, i.open, i.answers, i.silent);
    case "pair": return `${template(i.first)} ${template(i.second)}`;
    case "organizer_help": return `i can ask everyone for you, just text "ask everyone" and your question. or text status, start, or need cooler.`;
    case "add_needs_trip": return "start a trip first, then send me contacts. tell me what and when, like \"camping trip saturday\".";
  }
}

function topicLabel(topic: AskTopic, item: string | null): string {
  if (topic === "item") return `bringing a ${item ?? "thing"}`;
  if (topic === "drive" || topic === "seats") return "driving";
  if (topic === "budget") return "their budget";
  if (topic === "poll") return "your question";
  if (topic === "interview") return "the trip setup";
  if (topic === "interest" || topic === "constraint") return "what they're into";
  return "whether they're coming";
}

function ackText(topic: AskTopic, value: "yes" | "no" | "maybe" | "skip" | "done"): string {
  if (topic === "rsvp") {
    if (value === "yes") return "nice, you're in";
    if (value === "maybe") return "no stress, i'll plan like you're in. just tell me if it changes";
    return "no worries, thanks for telling me";
  }
  if (topic === "budget") return value === "skip" ? "easy, i'll plan around everyone else" : "noted, that stays with me";
  if (topic === "drive" || topic === "seats") return value === "yes" ? "perfect, thank you" : "no stress, i'll get you in someone's car";
  if (topic === "item") return value === "yes" ? "perfect, that's your job then" : "np, i'll ask around";
  return "got it";
}

/**
 * Intents Gemini may reword so the bot sounds like a person, not a form. Plans, summaries, stop confirmations,
 * and anything with exact wording to copy (commands like "start") stay as templates.
 */
const LLM_OK = new Set<MessageIntent["kind"]>([
  // Standalone acks ("got it, that stays between us") stay templates: instant beats varied for a one-liner.
  // An ack paired with the next question is still reworded, since the question decides the pair.
  "ask_rsvp", "ask_drive", "ask_item", "ask_budget", "ask_seats", "ask_poll", "nudge", "reask", "drop_ack",
  "waiting_for_start", "all_set", "handoff_member", "organizer_drop", "question_answer", "already_member",
  "poll_ack", "status_report",
]);

/** `reportLlm` (optional, slower timeout) writes poll summaries: nobody is watching a typing bubble for those. */
export function makePhraser(llm: Llm | null, reportLlm: Llm | null = llm): Phraser {
  return async (intent, history = []) => {
    const draft = template(intent);
    if (intent.kind === "poll_report") return reportLlm ? summarizePoll(reportLlm, intent, draft) : draft;
    const rewordable = LLM_OK.has(intent.kind) || (intent.kind === "pair" && LLM_OK.has(intent.second.kind));
    const long = intent.kind === "text" || intent.kind === "invite_line" || intent.kind === "status_report";
    if (!llm || !rewordable) return long ? draft : clip(draft);
    try {
      const out = clip((await llm.generate(phrasePrompt(intent, draft, history), { system: PHRASE_SYSTEM })).trim().replace(/^["']|["']$/g, ""), long ? 240 : 160);
      return isSafeRewrite(draft, out, intent) ? out : long ? draft : clip(draft);
    } catch {
      return clip(draft);
    }
  };
}

/** Reject rewrites that add numbers, drop or add questions, lose the AI disclosure / stop option / trip name. */
export function isSafeRewrite(draft: string, out: string, intent?: MessageIntent): boolean {
  if (out.length < 5 || out.includes("\n") || soundsLikeMeta(out, draft)) return false;
  if (draft.includes("?") !== out.includes("?")) return false;
  if ((out.match(/\?/g) ?? []).length > 1) return false; // one question per message
  if (/\bAI\b/.test(draft) && !/\bAI\b/i.test(out)) return false; // first contact must say it's an AI
  if (/\bstop\b/i.test(draft) && !/\bstop\b/i.test(out)) return false;
  const facts = intent?.kind === "pair" ? intent.second : intent;
  const trip = facts && "trip" in facts ? facts.trip : null;
  if (trip && draft.includes(trip) && !out.toLowerCase().includes(trip.toLowerCase())) return false;
  // (Name capitals are fixed in code before sending: engine fixNames.)
  const draftNums = new Set([...(draft.match(/\d+/g) ?? []), ...(JSON.stringify(intent ?? {}).match(/\d+/g) ?? [])]); // what they said counts too
  return (out.match(/\d+/g) ?? []).every((n) => draftNums.has(n));
}

/**
 * The organizer's question came back: summarize what people said in plain words and point out the option that
 * works for the most people. Falls back to the raw list if the model fails or adds numbers nobody said.
 */
async function summarizePoll(llm: Llm, i: Extract<MessageIntent, { kind: "poll_report" }>, draft: string): Promise<string> {
  const answers = i.answers.map((a) => `${a.name}: ${a.answer}`).join("\n") || "(nobody answered)";
  const one = i.answers.length + i.silent.length === 1;
  const how = one
    ? `Only one person was asked, so keep it short and natural, like "${draft}". Don't mention that they were the only one asked.`
    : `Under 300 characters. If there's an option that works for everyone or most people, lead with it and say who it doesn't work for and why (if they said). Don't give counts or tallies, talk about people.${i.silent.length ? " Mention who didn't answer." : ""}`;
  const prompt = `You are Roundup, texting the trip organizer on iMessage. For them, you asked: "${i.question}"
Answers:
${answers}
${i.silent.length ? `No answer from: ${i.silent.join(", ")}` : "Everyone you asked has answered."}

Write one text telling the organizer what people said, like a friend catching them up. ${how} Use only what's in the answers. If someone answered with just an emoji, say what it means (👍 is a yes, ⛺ to a hiking-or-camping question means camping). Don't quote the question back. No questions. Casual texting style, lowercase is fine. Reply with only the text.`;
  try {
    const out = clip((await llm.generate(prompt)).trim().replace(/^["']|["']$/g, ""), 320);
    const known = new Set(`${i.question} ${answers}`.match(/\d+/g) ?? []);
    const grounded = (out.match(/\d+/g) ?? []).every((n) => known.has(n) || Number(n) === i.answers.length || Number(n) === i.silent.length);
    return grounded && out.length > 10 && !soundsLikeMeta(out) ? out : draft;
  } catch {
    return draft;
  }
}
