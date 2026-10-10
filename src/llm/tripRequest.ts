// Gemini reads a free-text "let's plan something" message and pulls out a short title and date.
// Used only when the keyword rules in engine/intents.ts can't tell. Code still decides what happens.
import { z } from "zod";
import type { TripRequest } from "../engine/intents.js";
import type { Llm } from "./gemini.js";

export type TripExtractor = (text: string) => Promise<TripRequest | null>;

const schema = z.object({
  isPlanning: z.boolean(),
  title: z.string().max(60).nullable(),
  date: z.string().max(40).nullable(),
});

function prompt(text: string): string {
  return `Someone texted an assistant that helps friend groups plan trips and outings.
Their message: "${text.replace(/"/g, "'")}"

Return JSON only: {"isPlanning": boolean, "title": string|null, "date": string|null}
- isPlanning: true if they want to plan or organize any group trip, outing, event, or hangout.
- title: a short name for it, 1-4 words, sentence case, e.g. "Camping trip", "Six Flags day", "Bday dinner". null if not planning.
- date: the date or day exactly as they said it, lowercase, e.g. "next saturday", "saturday or sunday". null if not stated. Never guess.`;
}

export function makeTripExtractor(llm: Llm | null): TripExtractor | undefined {
  if (!llm) return undefined;
  return async (text) => {
    try {
      const out = schema.parse(JSON.parse((await llm.generate(prompt(text), { json: true })).replace(/```(?:json)?/gi, "").trim()));
      if (!out.isPlanning || !out.title) return null;
      return { title: out.title.trim(), dateText: out.date?.trim().toLowerCase() || null };
    } catch (err) {
      console.warn(`[tripRequest] LLM failed: ${(err as Error).message}`);
      return null;
    }
  };
}
