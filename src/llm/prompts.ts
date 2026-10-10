// The prompt strings sent to Gemini. Kept short so replies stay fast.
import type { AskTopic, MessageIntent } from "../types.js";
import { PHRASE_EXAMPLES, VOICE } from "./examples.js";

/** Stable system prompt for rewording drafts: the voice guide and examples (cached by the provider). */
export const PHRASE_SYSTEM = `You are Roundup, an AI texting friends 1:1 on iMessage to help plan a group trip.\n\n${VOICE}\n\n${PHRASE_EXAMPLES}`;

const TOPIC_QUESTION: Record<AskTopic, string> = {
  name: "What is your first name?",
  rsvp: "Are you coming on the trip? (yes / no / maybe)",
  budget: "What's the most you'd want to spend on the trip, in dollars?",
  drive: "Can you drive, and how many seats does your car have including you?",
  seats: "How many seats does your car have, including you?",
  item: "Can you bring the item we asked about?",
  poll: "Does the organizer's suggestion work for you? (yes / no / maybe)",
};

export function understandPrompt(text: string, topic: AskTopic | null, history: { from: "them" | "bot"; text: string }[] = []): string {
  const q = topic ? `The question they were asked: "${TOPIC_QUESTION[topic]}"` : "They were not asked anything just now.";
  const recent = history.length ? `Recent messages:\n${history.map((t) => `${t.from === "bot" ? "assistant" : "them"}: ${t.text}`).join("\n")}\n` : "";
  return `You read text replies for a group trip planning assistant.
${recent}${q}
Their reply: "${text.replace(/"/g, "'")}"

Return JSON only, with exactly these keys:
{"intent": "answer"|"drop"|"question"|"opt_out"|"other",
 "rsvp": "yes"|"no"|"maybe"|null, "canDrive": true|false|null, "seats": integer|null,
 "budgetCap": number|null, "itemYes": true|false|null, "confidence": number 0-1}

Rules: extract only what the person stated. Use null for anything not stated. Never guess a number.
"seats" is total seats including the driver. "drop" means they can no longer come on the trip.
"question" means they are asking something. "opt_out" means they want no more messages.`;
}

export function phrasePrompt(intent: MessageIntent, draft: string, history: { from: "them" | "bot"; text: string }[] = []): string {
  const recent = history.length
    ? history.map((t) => `${t.from === "bot" ? "you" : "them"}: ${t.text}`).join("\n")
    : "(first message)";
  return `Rewrite the draft so it sounds like a real person texting, and fits the conversation so far.

Conversation so far:
${recent}

Draft: "${draft}"
Facts (use only these): ${JSON.stringify(intent)}

Rules: casual and warm, lowercase is fine, like a friend not a form. one message under 140 characters.
keep the exact meaning. if the draft asks a question, ask that same single question; if it doesn't, don't add one.
keep "AI" and "stop" if the draft has them. write names and the trip name exactly as given (same capitals).
don't start the same way as your last message. if you've already greeted them above, don't greet again (no "hey Sam!"). don't repeat their name every time.
no filler openers like "ok", "next q", "first one", "quick q" unless the draft has them. no commentary or guesses about their situation.
at most one emoji, usually none. never add details, numbers, or times. reply with only the message text.`;
}
