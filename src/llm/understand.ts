// Turns a member's free-text reply into a validated ParsedReply.
// Keyword parsing runs first (fast, free). Gemini is only called when the keywords are not confident.
import { z } from "zod";
import type { AskTopic, ParsedReply } from "../types.js";
import type { Llm } from "./gemini.js";
import { understandPrompt } from "./prompts.js";

export type Understander = (text: string, topic: AskTopic | null, history?: { from: "them" | "bot"; text: string }[]) => Promise<ParsedReply>;

const parsedSchema = z.object({
  intent: z.enum(["answer", "drop", "question", "opt_out", "other"]),
  rsvp: z.enum(["yes", "no", "maybe"]).nullable(),
  canDrive: z.boolean().nullable(),
  seats: z.number().int().min(1).max(15).nullable(),
  budgetCap: z.number().min(0).max(100000).nullable(),
  itemYes: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
});

const YES = /^(y|ya|yes|yess+|yeah|yea|yep|yup|sure|ok|okay|k|definitely|absolutely|of course|for sure|i'?m in|im in|count me in|down|i'?m down|totally|bet|sounds good|yes please)\b/;
const NO = /^(n|no|nope|nah|nay|not really|sorry no|no sorry|can'?t|cannot|i can'?t|unfortunately not|negative)\b/;
const MAYBE = /\b(maybe|not sure|possibly|idk|i don'?t know|might|prob|probably|tbd|unsure|depends)\b/;
const DROP = /\b(can'?t (make it|come)( anymore)?|cannot (come|make it)|not (coming|going) anymore|have to (bail|cancel)|i'?m out\b|drop(ping)? out|gotta bail|won'?t be able to (come|make it))\b/;
const CAR = /\b(i have a car|i'?ve got a car|i got a car|i can drive|i('ll| will) drive|my car|i have a (van|truck|suv))\b/;
const NO_DRIVE = /\b(can'?t drive|no car|don'?t have a car|i don'?t drive|cannot drive)\b/;
const SKIP_BUDGET = /\b(no limit|whatever|flexible|don'?t care|any(thing)?|skip|rather not|prefer not|pass)\b/;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function firstNumber(t: string): number | null {
  const m = t.match(/\$?\s?(\d{1,5})(?:\.\d+)?/);
  if (m) return Number(m[1]);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  return null;
}

function blank(confidence: number, intent: ParsedReply["intent"] = "answer"): ParsedReply {
  return { intent, rsvp: null, canDrive: null, seats: null, budgetCap: null, itemYes: null, confidence };
}

/** Rule-based parser. Confident only on short, obvious replies. */
export function keywordParse(raw: string, topic: AskTopic | null): ParsedReply {
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[!.,]+/g, " ").replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean).length;
  const short = words <= 6;
  const yes = YES.test(t);
  const no = NO.test(t) && !yes;
  const maybe = MAYBE.test(t);
  const num = firstNumber(t);

  // "depends who's going" / "who else is coming?" -> they want info before answering.
  if (/\b(depends (on )?(who|whos|who's|what|when|where|how much)|who('?s| is| else)( else)? (going|coming|in))\b/.test(t)) {
    return blank(0.9, "question");
  }

  if (DROP.test(t)) {
    const r = blank(0.9, topic === "rsvp" || topic === "poll" ? "answer" : "drop");
    r.rsvp = "no";
    return r;
  }

  const carHint = CAR.test(t) ? true : NO_DRIVE.test(t) ? false : null;

  switch (topic) {
    case "poll":
    case "rsvp": {
      const r = blank(short ? 0.9 : 0.5);
      if (maybe) r.rsvp = "maybe";
      else if (yes) r.rsvp = "yes";
      else if (no) r.rsvp = "no";
      else return { ...blank(0.2, raw.trim().endsWith("?") ? "question" : "other"), canDrive: carHint };
      r.canDrive = carHint;
      if (carHint) r.seats = /seat|spot|people|fit/.test(t) ? num : null;
      if (carHint !== null) r.confidence = 0.9;
      return r;
    }
    case "budget": {
      if (num !== null) return { ...blank(0.95), budgetCap: num };
      if (SKIP_BUDGET.test(t)) return blank(0.85); // answered, but chose not to give a number
      return blank(0.2, raw.trim().endsWith("?") ? "question" : "other");
    }
    case "drive":
    case "seats": {
      if (no || NO_DRIVE.test(t)) return { ...blank(0.9), canDrive: false };
      if (num !== null && (yes || topic === "seats" || /seat|spot|people|fit|car/.test(t) || words <= 2)) {
        return { ...blank(0.9), canDrive: true, seats: num };
      }
      if (yes || carHint) return { ...blank(short ? 0.9 : 0.6), canDrive: true };
      return blank(0.2, raw.trim().endsWith("?") ? "question" : "other");
    }
    case "item": {
      if (yes) return { ...blank(short ? 0.9 : 0.6), itemYes: true };
      if (no) return { ...blank(short ? 0.9 : 0.6), itemYes: false };
      return blank(0.2, raw.trim().endsWith("?") ? "question" : "other");
    }
    default: {
      // No open question: look for changed answers or questions.
      if (raw.trim().endsWith("?")) return blank(0.7, "question");
      if (carHint !== null) return { ...blank(0.85), canDrive: carHint, seats: carHint ? num : null };
      return blank(0.3, "other");
    }
  }
}

/** Strip ```json fences and parse. Throws on bad JSON or schema mismatch. */
export function parseModelJson(text: string): ParsedReply {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  return parsedSchema.parse(JSON.parse(stripped));
}

export function makeUnderstander(llm: Llm | null): Understander {
  return async (text, topic, history = []) => {
    const quick = keywordParse(text, topic);
    if (quick.confidence >= 0.85 || !llm) return quick;
    try {
      const out = await llm.generate(understandPrompt(text, topic, history), { json: true });
      return parseModelJson(out);
    } catch (err) {
      console.warn(`[understand] LLM failed, using keyword result: ${(err as Error).message}`);
      return quick;
    }
  };
}
