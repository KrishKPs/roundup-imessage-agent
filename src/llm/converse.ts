// The conversational layer: for texts that aren't a plain answer or an exact command, Gemini reads the
// message with the trip facts and recent chat, picks ONE action from a fixed list, and writes a short reply.
// Code checks and runs the action. The reply may only use facts it was given (checked again in code).
import { z } from "zod";
import { clip } from "../util.js";
import type { Llm } from "./gemini.js";
import { converseSystem } from "./examples.js";

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

const organizerActions = ["reply", "ask_everyone", "tell_everyone", "status", "start", "send_plans", "add_items", "set_date"] as const;
const memberActions = ["reply", "pass_to_organizer", "tell_organizer"] as const;

const schema = z.object({
  action: z.enum([...organizerActions, ...memberActions]),
  question: z.string().max(160).nullable().optional(), // ask_everyone
  open: z.boolean().nullable().optional(), // unused now (every question is open); tolerated if the model sends it
  to: z.array(z.string().max(30)).max(20).nullable().optional(), // ask_everyone / tell_everyone: just these people (null = everyone)
  items: z.array(z.string().max(30)).max(6).nullable().optional(), // add_items
  message: z.string().max(200).nullable().optional(), // tell_everyone
  note: z.string().max(160).nullable().optional(), // pass_to_organizer / tell_organizer: short summary for the organizer
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
    ? `- "reply": just answer or chat (questions about the trip, thanks, small talk). If they ask about the answers to their question (e.g. "what time works for everyone?"), work it out from the answers in TRIP FACTS: give the option that fits the most people and who it doesn't work for.
- "ask_everyone": they want a NEW question asked (works anytime, even before start). Put the question, written TO the person being asked, in "question" (e.g. "does 10am saturday work for you?", "can you bring the tent?"). If they named specific people ("ask Sam...", "check with Maya and Leo..."), put just those first names in "to"; otherwise "to" is null (everyone). Don't re-ask a question that's already been answered; use "reply" with the answers instead.
- "tell_everyone": they want a note sent (no answer needed). Put it in "message", in their voice, cleaned up (e.g. "bring sunscreen and a towel!"). If they named specific people ("tell Leo..."), put just those first names in "to"; otherwise "to" is null (everyone).
- "status": they want an update on who's in / what's left.
- "start": they say everyone's in and want to kick things off.
- "send_plans": they want to wrap up and send everyone their plans now.
- "add_items": they want someone to bring things. Put short item names in "items" (e.g. ["cooler","speaker"]).
- "set_date": they're setting or changing the date/time. Put it in "date" as they said it (e.g. "saturday 12pm"). Just do it, don't question it.
For anything other than "reply", leave "reply" null; the app sends its own confirmation.`
    : `- "reply": answer from the facts, or chat back. Use this for thanks, small talk, and questions the facts answer.
- "pass_to_organizer": they asked something the facts don't answer (cost, address, plus-ones, what to bring...). Reply saying you'll check with the organizer. Put a short summary of their question in "note", in third person, e.g. "can they bring their bf?".
- "tell_organizer": they shared something the organizer should know (running late, allergy, leaving early). Reply that you'll pass it on. Put a short summary in "note", e.g. "running about 30 min late".
"note" goes only to the organizer: never put a budget or dollar amount in it.`;

  return `You're texting ${i.name || "someone"}, ${i.role === "organizer" ? "who organized this trip" : "a member of this trip"}.

TRIP FACTS (the only things you know):
${i.facts}

RECENT MESSAGES:
${history}

THEIR NEW MESSAGE: "${i.text.replace(/"/g, "'")}"

Pick exactly one action:
${actions}

Reply style: like a friend texting. lowercase ok. 1-2 short sentences, under 200 characters. at most one emoji, usually none.
Hard rules: never invent details that aren't in TRIP FACTS (no times, places, prices, names). never reveal anyone's budget except their own. never say you'll do something not in the action list. don't ask them questions (the app asks its own questions at the right time); just answer or acknowledge. don't repeat your last message, and don't greet them again mid-conversation. output only the final text, never notes about it.

Return JSON only: {"action": string, "question": string|null, "to": string[]|null, "items": string[]|null, "date": string|null, "message": string|null, "note": string|null, "reply": string|null}`;
}

export function makeConverser(llm: Llm | null): Converser | undefined {
  if (!llm) return undefined;
  return async (input) => {
    try {
      const raw = await llm.generate(prompt(input), { json: true, system: converseSystem(input.role) });
      const out = schema.parse(JSON.parse(raw.replace(/```(?:json)?/gi, "").trim()));
      const allowed: readonly string[] = input.role === "organizer" ? organizerActions : memberActions;
      if (!allowed.includes(out.action)) return null;
      if (out.reply) out.reply = clip(out.reply, 220);
      return out;
    } catch (err) {
      console.warn(`[converse] LLM failed: ${(err as Error).message}`);
      return null;
    }
  };
}

/** The model narrating its own writing ("let me fix", "the draft", "filler") must never reach a phone. */
export function soundsLikeMeta(text: string, source = ""): boolean {
  if (/\b(let me (fix|redo|rewrite|try again)|the draft|rewrite|filler|as instructed|capitali[sz]ed?|lowercase|here'?s (the|a) (text|message|reply)|i'?ll rephrase)\b|^(reply|message|text):|\bwait, (need|that|i|no)\b/i.test(text)) return true;
  if (/"[^"]{1,40}"/.test(text) && !/"/.test(source)) return true; // quoting words at itself
  // Says the same thing twice (a draft, then a "fixed" draft).
  const t = text.toLowerCase();
  for (let i = 0; i + 24 <= t.length; i += 4) if (t.indexOf(t.slice(i, i + 24), i + 24) !== -1) return true;
  return false;
}

/** A reply may not introduce numbers that aren't in the facts or their message (no made-up times, prices, seats). */
export function replyIsGrounded(reply: string, facts: string, text: string): boolean {
  const tripFacts = facts.split("\n").filter((l) => !l.startsWith("now:")).join("\n"); // the clock isn't a trip time
  const known = new Set([...(tripFacts.match(/\d+/g) ?? []), ...(text.match(/\d+/g) ?? [])]);
  return (reply.match(/\d+/g) ?? []).every((n) => known.has(n)) && reply.trim().length >= 2 && !soundsLikeMeta(reply, text);
}
