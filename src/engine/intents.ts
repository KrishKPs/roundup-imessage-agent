// Loose, forgiving matching for the things people say to start, join, or run a trip.
// People don't type exact commands, so "New camping trip, maybe around saturday or sunday"
// has to work as well as "new trip Camping on Saturday". Pure functions, no LLM needed.

const KIND_WORDS = "road ?trip|trip|getaway|vacation|weekend|outing|hike|party|retreat|day out|day";
const ACTIVITY_WORDS = ["camping", "beach", "ski", "skiing", "lake", "hiking", "fishing", "concert", "festival", "cabin"];
const FILLER = new Set([
  "new", "a", "an", "the", "plan", "planning", "plans", "i", "i'm", "im", "want", "wanna", "to", "lets", "let's",
  "organize", "organizing", "start", "starting", "create", "make", "our", "my", "this", "next", "for", "us", "we",
  "are", "going", "on", "quick", "group", "little", "hey", "hi", "hello", "yo", "so", "can", "you", "help", "me",
  "with", "do", "a", "doing", "some", "kind", "of", "like", "maybe", "around", "about", "thinking",
]);
const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_RE = new RegExp(
  [
    `(?:this|next|on|around|maybe)?\\s*${DAY}(?:\\s*(?:or|and|-|to|/|&)\\s*${DAY})*`,
    "(?:this|next) weekend",
    "tomorrow|tonight",
    `${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*-\\s*\\d{1,2})?`,
    "\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?",
  ].join("|"),
  "i",
);

export interface TripRequest {
  title: string;
  dateText: string | null;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Pull a rough date like "saturday or sunday", "next weekend", "oct 18" out of text. */
export function parseDate(text: string): string | null {
  const m = text.match(DATE_RE);
  if (!m) return null;
  return m[0].replace(/^(this|on|around|maybe)\s+/i, "").replace(/\s+/g, " ").trim().toLowerCase() || null;
}

/** Does this look like someone wanting to plan a trip? Returns a title and date, or null. */
export function parseTripRequest(raw: string): TripRequest | null {
  const text = raw.replace(/\s*\n\s*/g, ". ").trim();
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  if (/^(what|when|which|how|who|where|why|is|are|do|does|did)\b/.test(lower)) return null; // a question, not a plan
  const dateText = parseDate(lower);
  const withoutDate = dateText ? lower.replace(DATE_RE, " ") : lower;

  // Explicit "new trip <name> [on <date>]": take the name as written.
  const explicit = text.match(/^new trip\s*:?\s+(.+)$/i);
  if (explicit) {
    const name = explicit[1].replace(DATE_RE, " ").replace(/\s+(on|around|this|next)\s*$/i, "").replace(/[\s,.!-]+$/, "").trim();
    if (name) return { title: cap(name).slice(0, 40), dateText };
  }

  // "trip to asheville" -> "Trip to Asheville"
  const to = withoutDate.match(/\b(?:trip|getaway|vacation|weekend)\s+to\s+([a-z][a-z .'-]{1,24}?)(?=\s+(?:on|this|next|around|with|for)\b|[,.!?]|$)/);
  if (to) return { title: `Trip to ${to[1].trim().split(" ").map(cap).join(" ")}`, dateText };

  // "<words> trip", e.g. "new camping trip", "beach day", "ski weekend"
  const kind = withoutDate.match(new RegExp(`((?:[a-z'-]+\\s+){0,3})(${KIND_WORDS})\\b`));
  if (kind) {
    const words = kind[1].trim().split(/\s+/).filter((w) => w && !FILLER.has(w));
    const kindWord = kind[2];
    if (kindWord === "day" && !words.length) return null; // "what day" etc. is not a trip
    return { title: cap(`${words.join(" ")} ${kindWord}`.trim()).slice(0, 40), dateText };
  }

  // "camping saturday?" with no trip word
  const activity = ACTIVITY_WORDS.find((a) => new RegExp(`\\b${a}\\b`).test(withoutDate));
  if (activity) return { title: `${cap(activity)} trip`, dateText };
  return null;
}

/** A join code anywhere in the message: "BEACH7", "join beach7", "can i join BEACH7?" */
export function findJoinCode(text: string, codes: Iterable<string>): string | null {
  const tokens = new Set(text.toUpperCase().match(/[A-Z0-9]{4,7}/g) ?? []);
  for (const code of codes) if (tokens.has(code)) return code;
  return null;
}

/** Name after the code in "join BEACH7 Sam" / "BEACH7, i'm Sam". */
export function textAfterCode(text: string, code: string): string {
  const i = text.toUpperCase().indexOf(code);
  return i < 0 ? "" : text.slice(i + code.length).replace(/^[\s,.!-]+/, "").trim();
}

export type OrganizerVerb = "start" | "status" | "plan" | null;

export function organizerVerb(raw: string): OrganizerVerb {
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/g, "").trim();
  if (/^(start|go|start it|start the trip|start asking|let'?s (start|go|do (it|this))|kick (it )?off|everyone'?s in|we'?re all in|send (it|the questions)|ok start|okay start)$/.test(t)) return "start";
  if (/^(status|update|progress|where are we( at)?|how'?s it going|how are we doing|what'?s left)$/.test(t)) return "status";
  if (/^(plan|send (the )?plans?|finali[sz]e|lock it in|wrap it up)$/.test(t)) return "plan";
  return null;
}
