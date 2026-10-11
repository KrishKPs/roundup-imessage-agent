// Drafts and edits the itinerary from the trip facts. Code checks the result before the organizer sees it:
// no prices except the group budget, no people who aren't on the trip, no notes-to-self, sane length.
import type { Llm } from "./gemini.js";
import { soundsLikeMeta } from "./converse.js";

export interface ItineraryInput {
  facts: string; // engine/itinerary.ts itineraryFacts: names, cars, items, group budget, answers, heads-ups
  draft: string | null; // the current itinerary, when the organizer is asking for a change
  change: string | null; // what they want changed, in their words
  names: string[]; // everyone on the trip (the only people the plan may mention)
  budget: number | null; // the only dollar amount allowed
}

export type ItineraryWriter = (input: ItineraryInput) => Promise<string | null>;

const SYSTEM = `You write group-trip itineraries that get texted to friends. Plain text, no markdown, no bullet symbols except an emoji at the start of a line if it helps (one per line max).

Format: first line is "<trip> · <day/time> · <place>". Then 4-10 short lines in time order: when and where to meet, who rides with whom, the main plan for the day using what people said, what to bring and who's bringing it, and the budget line if there is one. Each line under 70 characters.

Rules:
- Use only the facts given. Never add venues, restaurants, addresses, prices, or people that aren't in the facts.
- You may suggest simple timings (like leaving an hour before) and generic steps (like "lunch", "swim", "head home"), but keep them plausible and few.
- Use what people said (availability, preferences) to choose times that work for everyone, but never attribute personal details to a name (write "snacks: no peanuts", never "Maya's allergic to peanuts").
- No individual budgets. Only the group budget line, exactly as given.
- It's a plan people read, not a message: no questions, no asking people to reply or volunteer, no greetings or sign-offs. If something isn't sorted yet (rides, an item), just say it's still being sorted.
- Output only the itinerary text.`;

function prompt(i: ItineraryInput): string {
  if (i.draft && i.change) {
    return `TRIP FACTS:\n${i.facts}\n\nCURRENT ITINERARY:\n${i.draft}\n\nTHE ORGANIZER WANTS THIS CHANGE: "${i.change.replace(/"/g, "'")}"\n\nRewrite the whole itinerary with that change applied. Keep everything else the same.`;
  }
  return `TRIP FACTS:\n${i.facts}\n\nWrite the itinerary.`;
}

/** Code checks on the model's itinerary. Returns the cleaned text, or null to fall back. */
export function checkItinerary(text: string, i: ItineraryInput): string | null {
  const r = itineraryProblem(text, i);
  if (typeof r !== "string" || r.startsWith("ok:")) return typeof r === "string" ? r.slice(3) : null;
  console.warn(`[itinerary] rejected draft: ${r}`);
  return null;
}

function itineraryProblem(text: string, i: ItineraryInput): string {
  const t = text.replace(/```[a-z]*/gi, "").replace(/^\s*[-*•]\s+/gm, "").replace(/\*\*/g, "").trim();
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 14 || t.length > 900) return `length (${lines.length} lines, ${t.length} chars)`;
  const meta = lines.find((l) => soundsLikeMeta(l, '"'));
  if (meta) return `meta/self-talk: "${meta}"`;
  // Money: only the group budget, and only if there is one.
  for (const m of t.matchAll(/\$\s?(\d+)/g)) if (i.budget === null || Number(m[1]) !== i.budget) return `price $${m[1]}`;
  // People: anyone named in a person's role ("Jessica drives", "with Jessica", "Jessica's bringing") must be on the trip.
  const known = new Set(i.names.map((n) => n.toLowerCase()));
  const factWords = new Set((i.facts + " " + (i.change ?? "")).toLowerCase().match(/[a-z']+/g) ?? []);
  const roles = /\b([A-Z][a-z]{2,})(?:'s)?\s+(?:drives|driving|brings|bringing|is bringing|will bring|picks|rides|has the|got the|and [A-Z])|\b(?:with|by|from|picks up|ride with|riding with)\s+([A-Z][a-z]{2,})\b/g;
  for (const m of t.matchAll(roles)) {
    const w = (m[1] ?? m[2]).toLowerCase();
    if (!known.has(w) && !factWords.has(w) && looksLikeName(m[1] ?? m[2])) return `unknown person "${m[1] ?? m[2]}"`;
  }
  return `ok:${lines.join("\n")}`;
}

/** Common capitalized words in itineraries that are not people. Anything else capitalized must come from the facts. */
const NOT_NAMES = new Set(("Meet Leave Arrive Head Lunch Dinner Breakfast Brunch Swim Hike Drive Drives Bring Budget Snacks Pickup Pick Home " +
  "Then Back Rides Ride Cars Car Everyone Group Plan Day Morning Afternoon Evening Night Noon Sunset Sunrise Free Time Games Music Setup Pack " +
  "Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mon Tue Wed Thu Fri Sat Sun Today Tomorrow Weekend Next This And Or Also Optional " +
  "Grab Food Water Gas Stop Start End Hang Chill Relax Beach Lake Park Camp Camping Trip Party Bonfire Movie Photos Wrap Done").split(" "));

function looksLikeName(w: string): boolean {
  return !NOT_NAMES.has(w);
}

export function makeItineraryWriter(llm: Llm | null): ItineraryWriter | undefined {
  if (!llm) return undefined;
  return async (input) => {
    try {
      const out = await llm.generate(prompt(input), { system: SYSTEM });
      const checked = checkItinerary(out, input);
      if (!checked) console.warn(`[itinerary] model draft was:\n${out}`);
      return checked;
    } catch (err) {
      console.warn(`[itinerary] LLM failed: ${(err as Error).message}`);
      return null;
    }
  };
}
