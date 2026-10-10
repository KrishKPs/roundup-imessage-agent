// Turns a MessageIntent into one short text. Every intent has a fixed template;
// a few casual ones may be reworded by Gemini, with the template as the fallback.
import type { AskTopic, MessageIntent } from "../types.js";
import { clip, joinLink, listNames } from "../util.js";
import type { Llm } from "./gemini.js";
import { phrasePrompt } from "./prompts.js";

export type Phraser = (intent: MessageIntent) => Promise<string>;

const SIMPLE_QUESTION: Record<AskTopic, string> = {
  name: "what's your first name?",
  rsvp: "are you coming? yes, no, or maybe works",
  budget: "what's the most you'd spend? a number like 50 works, or say skip",
  drive: "can you drive? yes or no works",
  seats: "how many seats in your car, including you? just a number",
  item: "can you bring it? yes or no works",
};

/** The fixed wording for every intent. Used directly, or as the draft for Gemini. */
export function template(i: MessageIntent): string {
  switch (i.kind) {
    case "text": return i.text;
    case "ask_name_member": return `hey! i'm Roundup, an AI helping ${i.organizer} plan ${i.trip}. what's your first name?`;
    case "ask_name_organizer": return "hey! i'm Roundup, an AI that plans group trips over text so the group chat doesn't have to. what's your first name?";
    case "intro": return `hey ${i.name}! i'm Roundup, an AI helping ${i.organizer} plan ${i.trip}. i'll ask you a few quick things here so the group chat stays quiet. reply stop anytime.`;
    case "trip_created": return `nice to meet you ${i.name}! ${i.trip} is set up, code ${i.code}. paste the next text in your group chat, then text start when everyone's in.`;
    case "invite_line":
      return i.agentNumber
        ? `${i.organizer} is planning ${i.trip}! tap to join: ${joinLink(i.agentNumber, i.code)} (or text "join ${i.code}" to ${i.agentNumber}). Roundup, an AI, sorts out the details with you 1:1.`
        : `${i.organizer} is planning ${i.trip}! text "join ${i.code}" to this number and Roundup will sort out the details with you 1:1.`;
    case "ask_rsvp": return `are you in for ${i.trip}${i.date ? ` on ${i.date}` : ""}? yes, no, or maybe`;
    case "ask_budget": return "what's the most you'd want to spend on this trip? stays private, i only share the group's lowest number.";
    case "ask_drive": return `can you drive for ${i.trip}? if yes, how many seats including you?`;
    case "ask_seats": return "nice! how many seats in your car, including you?";
    case "ask_item": return `could you bring a ${i.item} for ${i.trip}?`;
    case "reask": return `sorry, didn't catch that. ${SIMPLE_QUESTION[i.topic].replace("it?", i.item ? `a ${i.item}?` : "it?")}`;
    case "nudge": return `hey ${i.name}, no rush. ${SIMPLE_QUESTION[i.topic].replace("it?", i.item ? `a ${i.item}?` : "it?")}`;
    case "ack": return ackText(i.topic, i.value);
    case "handoff_member": return `no worries, i'll let ${i.organizer} follow up with you.`;
    case "handoff_organizer": return `heads up: i couldn't get a clear answer from ${i.name} about ${topicLabel(i.topic, i.item)}. can you check with them?`;
    case "question_answer": return `here's what i know: ${i.trip}${i.date ? `, ${i.date}` : ""}, organized by ${i.organizer}. for anything else i've flagged it to ${i.organizer}.`;
    case "question_organizer": return `${i.name} has a question about the trip that i couldn't answer. can you text them?`;
    case "drop_ack": return `totally get it ${i.name}, you're off the list. thanks for telling me!`;
    case "organizer_drop": return `heads up: ${i.name} can't come anymore. i'm rebalancing the plan.`;
    case "short_organizer": return `heads up: we're ${i.missing} ${i.unit} short for ${i.label} and i've asked everyone who could help. any ideas?`;
    case "stop_confirm": return "got it, you won't hear from me again. take care!";
    case "unknown_code": return "hmm, i don't know that code. can you double-check it with whoever invited you?";
    case "help": return "hey! i'm Roundup, an AI that plans group trips over text. planning something? tell me what and when, like \"camping trip saturday\". got a code? just send it.";
    case "already_member": return `you're already in ${i.trip}!`;
    case "waiting_for_start": return `you're all set! i'll text you once ${i.organizer} kicks things off.`;
    case "started_organizer": return `we're rolling! i'm texting all ${i.count} people now. text status anytime.`;
    case "needs_added": return `added: ${i.items.join(", ")}. i'll find people to bring them.`;
    case "not_organizer": return `only ${i.organizer} can do that one.`;
    case "late_ack": return "thanks, got it!";
    case "noted_car": return "good to know, thanks! i'll keep that in mind.";
    case "all_set": return "you're all set for now. i'll text you if anything changes.";
    case "invited": return `hey${i.name ? ` ${i.name}` : ""}! ${i.organizer} added you to ${i.trip}${i.date ? ` (${i.date})` : ""}. i'm Roundup, an AI helping plan it 1:1 so the group chat stays quiet. reply stop anytime.`;
    case "people_added": return `added ${listNames(i.names)} and texted them${i.skipped ? ` (skipped ${i.skipped} already in or opted out)` : ""}. ${i.started ? "they'll get the questions now." : "send more anytime, or say start when everyone's in."}`;
    case "ask_what_planning": return "hey! i'm Roundup, an AI that plans group trips over text. what are you planning, and when? anything works. got a code from a friend? just send it.";
    case "add_needs_trip": return "start a trip first, then send me contacts. tell me what and when, like \"camping trip saturday\".";
  }
}

function topicLabel(topic: AskTopic, item: string | null): string {
  if (topic === "item") return `bringing a ${item ?? "thing"}`;
  if (topic === "drive" || topic === "seats") return "driving";
  if (topic === "budget") return "their budget";
  return "whether they're coming";
}

function ackText(topic: AskTopic, value: "yes" | "no" | "maybe" | "skip" | "done"): string {
  if (topic === "rsvp") {
    if (value === "yes") return "awesome!";
    if (value === "maybe") return "no stress, i'll plan like you're in. just tell me if that changes.";
    return "no worries, thanks for letting me know!";
  }
  if (topic === "budget") return value === "skip" ? "all good." : "got it, that stays between us.";
  if (topic === "drive" || topic === "seats") return value === "yes" ? "amazing, thank you!" : "no worries!";
  if (topic === "item") return value === "yes" ? "perfect, thanks!" : "all good!";
  return "got it!";
}

/** Intents that are casual enough to let Gemini reword. Everything else is always the template. */
const LLM_OK = new Set<MessageIntent["kind"]>(["ask_rsvp", "ask_drive", "ask_item", "nudge", "drop_ack"]);

export function makePhraser(llm: Llm | null): Phraser {
  return async (intent) => {
    const draft = template(intent);
    if (!llm || !LLM_OK.has(intent.kind)) return intent.kind === "text" || intent.kind === "invite_line" ? draft : clip(draft);
    try {
      const out = clip((await llm.generate(phrasePrompt(intent, draft))).replace(/^["']|["']$/g, ""));
      return isSafeRewrite(draft, out) ? out : clip(draft);
    } catch {
      return clip(draft);
    }
  };
}

/** Reject rewrites that add numbers, drop the question, or come back empty. */
function isSafeRewrite(draft: string, out: string): boolean {
  if (out.length < 5) return false;
  if (draft.includes("?") && !out.includes("?")) return false;
  const draftNums = new Set(draft.match(/\d+/g) ?? []);
  return (out.match(/\d+/g) ?? []).every((n) => draftNums.has(n));
}
