// The conversational layer: for texts that aren't a plain answer or an exact command, Gemini reads the
// message with the trip facts and recent chat, picks ONE action from a fixed list, and writes a short reply.
// Code checks and runs the action. The reply may only use facts it was given (checked again in code).
import { z } from "zod";
import { clip } from "../util.js";
import type { Llm } from "./gemini.js";

export interface Turn {
  from: "them" | "bot";
  text: string;
}

export interface ConverseInput {
  role: "organizer" | "member";
  name: string;
  text: string;
  facts: string;
  history: Turn[];
}

const organizerActions = ["reply", "ask_everyone", "status", "start", "send_plans", "add_items", "set_date"] as const;
const memberActions = ["reply", "pass_to_organizer"] as const;

const schema = z.object({
  action: z.enum([...organizerActions, ...memberActions]),
  question: z.string().max(140).nullable().optional(), // ask_everyone
  items: z.array(z.string().max(30)).max(6).nullable().optional(), // add_items
  date: z.string().max(40).nullable().optional(), // set_date
  reply: z.string().max(300).nullable().optional(),
});

export type ConverseResult = z.infer<typeof schema>;
export type Converser = (input: ConverseInput) => Promise<ConverseResult | null>;

function prompt(i: ConverseInput): string {
  const history = i.history.length
    ? i.history.map((t) => `${t.from === "bot" ? "Roundup" : i.name || "them"}: ${t.text}`).join("\n")
    : "(no earlier messages)";
  const actions = i.role === "organizer"
    ? `- "reply": just answer or chat (use for questions about the trip, thanks, small talk).
- "ask_everyone": they want a question put to every member (works anytime, even before start). Put the question, phrased to the members, in "question" (e.g. "does 10am saturday work?").
- "status": they want an update on who's in / what's left.
- "start": they say everyone's in and want to kick things off.
- "send_plans": they want to wrap up and send everyone their plans now.
- "add_items": they want someone to bring things. Put short item names in "items" (e.g. ["cooler","speaker"]).
- "set_date": they're setting or changing the date/time. Put it in "date" as they said it (e.g. "saturday 12pm"). Just do it, don't question it.
For anything other than "reply", leave "reply" null; the app sends its own confirmation.`
    : `- "reply": answer from the facts, or chat back. Use this for thanks, small talk, and questions the facts answer.
- "pass_to_organizer": they asked something the facts don't answer (cost details, address, what to wear...). Reply saying you'll check with the organizer.`;

  return `You are Roundup, an AI that plans group trips by texting each friend 1:1 over iMessage. You're texting ${i.name || "someone"}, ${i.role === "organizer" ? "who organized this trip" : "a member of this trip"}.

TRIP FACTS (the only things you know):
${i.facts}

RECENT MESSAGES:
${history}

THEIR NEW MESSAGE: "${i.text.replace(/"/g, "'")}"

Pick exactly one action:
${actions}

Reply style: like a friend texting. lowercase ok. 1-2 short sentences, under 150 characters. at most one emoji, usually none.
Hard rules: never invent details that aren't in TRIP FACTS (no times, places, prices, names). never reveal anyone's budget except their own. never say you'll do something not in the action list. don't ask them questions (the app asks its own questions at the right time); just answer or acknowledge. don't repeat your last message, and don't greet them again mid-conversation. write names and the trip name exactly as given.

Return JSON only: {"action": string, "question": string|null, "items": string[]|null, "date": string|null, "reply": string|null}`;
}

export function makeConverser(llm: Llm | null): Converser | undefined {
  if (!llm) return undefined;
  return async (input) => {
    try {
      const raw = await llm.generate(prompt(input), { json: true });
      const out = schema.parse(JSON.parse(raw.replace(/```(?:json)?/gi, "").trim()));
      const allowed: readonly string[] = input.role === "organizer" ? organizerActions : memberActions;
      if (!allowed.includes(out.action)) return null;
      if (out.reply) out.reply = clip(out.reply);
      return out;
    } catch (err) {
      console.warn(`[converse] LLM failed: ${(err as Error).message}`);
      return null;
    }
  };
}

/** A reply may not introduce numbers that aren't in the facts or their message (no made-up times, prices, seats). */
export function replyIsGrounded(reply: string, facts: string, text: string): boolean {
  const tripFacts = facts.split("\n").filter((l) => !l.startsWith("now:")).join("\n"); // the clock isn't a trip time
  const known = new Set([...(tripFacts.match(/\d+/g) ?? []), ...(text.match(/\d+/g) ?? [])]);
  return (reply.match(/\d+/g) ?? []).every((n) => known.has(n)) && reply.trim().length >= 2;
}
