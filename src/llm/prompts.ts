// The prompt strings sent to Gemini. Kept short so replies stay fast.
import type { AskTopic, MessageIntent } from "../types.js";

const TOPIC_QUESTION: Record<AskTopic, string> = {
  name: "What is your first name?",
  rsvp: "Are you coming on the trip? (yes / no / maybe)",
  budget: "What's the most you'd want to spend on the trip, in dollars?",
  drive: "Can you drive, and how many seats does your car have including you?",
  seats: "How many seats does your car have, including you?",
  item: "Can you bring the item we asked about?",
  poll: "Does the organizer's suggestion work for you? (yes / no / maybe)",
};

export function understandPrompt(text: string, topic: AskTopic | null): string {
  const q = topic ? `The question they were asked: "${TOPIC_QUESTION[topic]}"` : "They were not asked anything just now.";
  return `You read text replies for a group trip planning assistant.
${q}
Their reply: "${text.replace(/"/g, "'")}"

Return JSON only, with exactly these keys:
{"intent": "answer"|"drop"|"question"|"opt_out"|"other",
 "rsvp": "yes"|"no"|"maybe"|null, "canDrive": true|false|null, "seats": integer|null,
 "budgetCap": number|null, "itemYes": true|false|null, "confidence": number 0-1}

Rules: extract only what the person stated. Use null for anything not stated. Never guess a number.
"seats" is total seats including the driver. "drop" means they can no longer come on the trip.
"question" means they are asking something. "opt_out" means they want no more messages.`;
}

export function phrasePrompt(intent: MessageIntent, draft: string): string {
  return `Rewrite this text message from Roundup, an AI that helps friends plan trips over iMessage.
Draft: "${draft}"
Facts (do not add any others): ${JSON.stringify(intent)}

Rules: sound like a friendly friend texting. lowercase is fine. one short message, under 140 characters.
keep the same meaning and the same single question if there is one. at most one emoji, usually none.
do not invent any details. reply with only the message text.`;
}
