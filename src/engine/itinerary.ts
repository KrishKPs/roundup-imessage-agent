// The itinerary: turns everything the bot collected (who's going, cars, who brings what, answers to the organizer's
// questions, heads-ups) into a day plan. The organizer reviews and edits it over text, then "send it" gives every
// member their own short version plus a link to the trip page. Budgets stay private: only the group number appears.
import type { Phone, Trip } from "../types.js";
import { clip } from "../util.js";
import { type Ctx, goingMembers, nameOf, organizerName } from "./context.js";
import { assignSeats, groupBudget, planFor } from "./plan.js";
import { pollResults, polls } from "./poll.js";

/** "make the itinerary", "draft a plan for the day", "itinerary" */
export function isMakeItinerary(t: string): boolean {
  return /^(?:(?:can you |pls |please |let'?s )?(?:make|create|build|draft|write|do|show|put together|plan out)(?: me)?(?: (?:the|an|a|our))? (?:itinerary|schedule|plan for the day|day plan|game plan)|itinerary)\b/i.test(t.trim());
}

/** "send it", "send the itinerary", "looks good send it" */
export function isSendItinerary(t: string): boolean {
  return /^(?:(?:ok|okay|perfect|great|looks good|lgtm|nice|cool)[,!. ]*)?(?:send it|send the (?:itinerary|plan|schedule)|share it|ship it)\b/i.test(t.trim());
}

/** "we're going to Jordan Lake", "place: Jordan Lake", "headed to Six Flags" -> the place. */
export function parsePlace(t: string): string | null {
  const m = t.trim().match(/^(?:place|where|location|destination|spot)\s*[:=-]\s*(.+)$|^(?:we'?re |we are )?(?:going to|headed to|heading to)\s+(.+)$/i);
  const place = (m?.[1] ?? m?.[2])?.trim().replace(/[.!]+$/, "");
  return place && place.length >= 2 && place.length <= 60 ? place : null;
}

/**
 * What the itinerary writer may use. Names, cars, items, the group budget (only if 2+ shared), what people said
 * to the organizer's questions, and heads-ups. Never individual budgets, never phone numbers.
 */
export function itineraryFacts(trip: Trip): string {
  const going = goingMembers(trip);
  const seats = assignSeats(trip);
  const lines = [
    `trip: ${trip.title}`,
    `date/time: ${trip.dateText ?? "not set"}`,
    `place: ${trip.facts?.where || trip.place || "not set"}`,
    ...(trip.facts?.leaveAt ? [`leaving at: ${trip.facts.leaveAt}`] : []),
    ...(trip.facts?.meetAt ? [`meeting spot: ${trip.facts.meetAt}`] : []),
    ...(trip.facts?.backBy ? [`back by: ${trip.facts.backBy}`] : []),
    ...(trip.facts?.notes ? [`organizer's notes: ${trip.facts.notes}`] : []),
    `organizer: ${organizerName(trip)}`,
    `going: ${going.map((m) => m.name).join(", ") || "nobody yet"}`,
  ];
  for (const c of seats.cars) {
    lines.push(`car: ${nameOf(trip, c.driver)} drives${c.riders.length ? `, riders: ${c.riders.map((p) => nameOf(trip, p)).join(", ")}` : ", no riders"}`);
  }
  if (seats.unassigned.length) lines.push(`no ride yet: ${seats.unassigned.map((p) => nameOf(trip, p)).join(", ")}`);
  for (const n of trip.needs.filter((x) => x.kind === "item")) {
    lines.push(`bring ${n.label}: ${n.providers.map((p) => nameOf(trip, p)).join(", ") || "nobody yet"}`);
  }
  const budget = groupBudget(trip);
  lines.push(`group budget: ${budget !== null ? `everyone's comfortable up to $${budget}` : "not shared"}`);
  for (const poll of polls(trip).slice(-4)) {
    const { answers } = pollResults(trip, poll);
    if (answers.length) lines.push(`asked "${poll.question}": ${answers.map((a) => `${a.name}: ${a.answer}`).join("; ")}`);
  }
  for (const n of (trip.notes ?? []).slice(-6)) lines.push(`heads-up from ${n.name}: ${n.note}`);
  return lines.join("\n");
}

/** The no-AI itinerary: just the facts, in order. Also the fallback if the model fails. */
export function templateItinerary(trip: Trip): string {
  const seats = assignSeats(trip);
  const lines = [[trip.title, trip.dateText, trip.place].filter(Boolean).join(" · ")];
  for (const c of seats.cars) {
    lines.push(`🚗 ${nameOf(trip, c.driver)} drives${c.riders.length ? ` ${c.riders.map((p) => nameOf(trip, p)).join(", ")}` : ""}`);
  }
  if (seats.unassigned.length) lines.push(`still need rides for ${seats.unassigned.map((p) => nameOf(trip, p)).join(", ")}`);
  const items = trip.needs.filter((n) => n.kind === "item");
  if (items.length) {
    lines.push(`bring: ${items.map((n) => `${n.label} (${n.providers.map((p) => nameOf(trip, p)).join(", ") || "?"})`).join(", ")}`);
  }
  const budget = groupBudget(trip);
  if (budget !== null) lines.push(`budget: everyone's good up to $${budget}`);
  return lines.join("\n");
}

/** What the organizer sees for a new or edited draft. */
export function draftMessage(text: string, edited: boolean): string {
  return `${edited ? "updated" : "here's a first draft"}:\n\n${text}\n\n${edited ? "anything else?" : "want changes? just tell me, like \"push it an hour later\"."} text "send it" when it looks good.`;
}

/**
 * Send it: each member going gets their own short plan (their ride, what they bring) plus the trip page link.
 * After the first send, later sends only go out as "the plan changed" updates.
 */
export function sendItinerary(ctx: Ctx, trip: Trip, link: string | null): void {
  const it = trip.itinerary;
  if (!it) return;
  const again = it.sentAt !== null;
  it.sentAt = ctx.now();
  it.version = (it.version ?? 0) + 1;
  (it.changes ??= []).push({ version: it.version, at: ctx.now(), summary: again ? "plan updated by the organizer" : "first version sent" }); // the trip's stage doesn't change: rides etc. can still get sorted, and plans update then
  const seats = assignSeats(trip);
  const budget = groupBudget(trip);
  const reach = goingMembers(trip).filter((m) => m.phone !== trip.organizer && !m.optedOut && !((m.viaLink || m.invited) && !m.heardFrom));
  const page = link ? ` full plan: ${link}` : "";
  for (const m of reach) {
    if (again) {
      ctx.out(m.phone, { kind: "text", text: `heads up, ${organizerName(trip)} updated the plan for ${trip.title}.${page}` });
      continue;
    }
    const [first, second] = planFor(trip, m.phone, seats, budget);
    ctx.out(m.phone, { kind: "text", text: first });
    ctx.out(m.phone, { kind: "text", text: `${second ? `${second} ` : ""}${page.trim()}`.trim() || clip(first) });
    m.lastPlan = [first, second].filter(Boolean).join("\n");
  }
  const who = reach.length === 1 ? reach[0].name : `all ${reach.length} people`;
  ctx.out(trip.organizer, { kind: "text", text: reach.length ? `sent to ${who}!${link ? ` the trip page: ${link}` : ""}` : "nobody to send it to yet." });
  ctx.log(trip, "finalized", again ? "itinerary updated and re-sent" : `itinerary sent to ${reach.length} people`);
}

/** One timeline item, parsed from an itinerary line ("12:00 meet at Jordan Lake", "🔥 Sunset: bonfire"). */
export interface PlanItem {
  time: string | null;
  title: string;
  kind: "meet" | "drive" | "food" | "free" | "activity";
}

export function itineraryItems(text: string): PlanItem[] {
  return text.split("\n").slice(1).map((raw) => {
    // Drop a leading emoji/symbol icon: the page draws its own icons.
    const line = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const m = line.match(/^(\d{1,2}(?::\d{2})?\s?(?:am|pm)?|morning|midday|noon|afternoon|evening|sunset|night)\b[\s:.-]*(.*)$/i);
    const time = m && m[2] ? m[1].trim() : null;
    const title = (time ? m![2] : line).replace(/^[:\s-]+/, "").trim() || line;
    const t = title.toLowerCase();
    const kind: PlanItem["kind"] = /\b(meet|meeting|pick ?up)\b/.test(t) ? "meet"
      : /\b(drive|driving|leave|leaving|head (out|home)|rides?|cars?)\b/.test(t) ? "drive"
      : /\b(lunch|dinner|breakfast|brunch|food|eat|snacks?|grill|bbq|picnic|coffee)\b/.test(t) ? "food"
      : /\b(free time|hang|chill|relax|breathing room)\b/.test(t) ? "free" : "activity";
    return { time, title, kind };
  }).filter((x) => x.title);
}

/** Days until the trip, only when the date is a real calendar date ("oct 18", "10/18"); null for "saturday". */
export function daysUntil(dateText: string | null, now: number): number | null {
  if (!dateText) return null;
  const t = dateText.toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let month = -1, day = -1;
  const named = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (named) { month = months.indexOf(named[1]); day = Number(named[2]); }
  else if (slash) { month = Number(slash[1]) - 1; day = Number(slash[2]); }
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), month, day);
  if (d.getTime() < today.getTime() - 86_400_000) d = new Date(today.getFullYear() + 1, month, day);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** Where the trip is, for the progress strip and status chip. */
export function planStage(trip: Trip): "who" | "rides" | "stops" | "ready" {
  if (trip.itinerary?.sentAt) return "ready";
  if (trip.itinerary || trip.status === "finalized") return "stops";
  if (trip.status === "coordinating") return "rides";
  return "who";
}

/** The trip page: safe to show anyone with the link. Names only, no budgets except the group number, no phones. */
export function tripPage(trip: Trip, now = Date.now()): Record<string, unknown> {
  const seats = assignSeats(trip);
  const sent = !!trip.itinerary?.sentAt;
  const people = Object.values(trip.members).filter((m) => !m.optedOut && m.name);
  const first = (n: string) => n.split(/\s+/)[0]; // first names only, ever
  const f = trip.facts ?? {};
  const seatsNeedNow = trip.needs.find((n) => n.kind === "seats");
  return {
    title: trip.title,
    dateText: trip.dateText,
    place: f.where || trip.place || null,
    organizer: first(organizerName(trip)),
    stage: planStage(trip),
    daysUntil: daysUntil(trip.dateText, now),
    going: people.filter((m) => m.rsvp === "yes").map((m) => ({ name: first(m.name), organizer: m.phone === trip.organizer })),
    maybe: people.filter((m) => m.rsvp === "maybe").map((m) => first(m.name)),
    cars: seats.cars.map((c) => ({ driver: first(nameOf(trip, c.driver)), seats: c.seats, riders: c.riders.map((p: Phone) => first(nameOf(trip, p))) })),
    seatsSoFar: seatsNeedNow?.quantityFilled ?? 0,
    ridesOn: trip.settings?.rides !== false,
    bring: trip.needs.filter((n) => n.kind === "item").map((n) => ({ item: n.label, who: n.providers.map((p) => first(nameOf(trip, p))) })),
    budget: groupBudget(trip),
    goodToKnow: { meetAt: f.meetAt || null, leaveAt: f.leaveAt || null, backBy: f.backBy || null, notes: f.notes || null },
    itinerary: sent ? trip.itinerary!.text : null,
    items: sent ? itineraryItems(trip.itinerary!.text) : [],
    version: sent ? trip.itinerary!.version ?? 1 : 0,
    changes: sent ? (trip.itinerary!.changes ?? []).slice(-6).reverse() : [],
    updatedAt: trip.itinerary?.updatedAt ?? null,
  };
}
