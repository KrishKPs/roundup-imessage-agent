// What the AI may know when it talks to one person: trip facts, plus that person's OWN answers.
// Never another member's budget, never anyone's phone number. The AI may only say what is in here.
import type { Member, Trip } from "../types.js";
import { type Ctx, byJoin, nameOf, seatsNeed } from "./context.js";
import { pollResults, polls } from "./poll.js";
import { assignSeats, budgetAnsweredCount, groupBudget } from "./plan.js";

const names = (ms: Member[]) => ms.map((m) => m.name || "someone").join(", ") || "nobody";

export function factsFor(trip: Trip, me: Member, ctx: Ctx): string {
  const people = byJoin(trip).filter((m) => !m.optedOut);
  const isOrganizer = me.phone === trip.organizer;
  const lines = [
    `trip: ${trip.title}`,
    `date: ${trip.dateText ?? "not set yet"}`,
    `place: ${trip.place ?? "not set yet"}`,
    `where: ${trip.facts?.where || trip.place || "not set (say you'll check with the organizer)"}`,
    `leaving at: ${trip.facts?.leaveAt || "not set (say you'll check with the organizer)"}`,
    `meeting spot: ${trip.facts?.meetAt || "not set (say you'll check with the organizer)"}`,
    `back by: ${trip.facts?.backBy || "not set (say you'll check with the organizer)"}`,
    ...(trip.facts?.notes ? [`organizer's notes for everyone: ${trip.facts.notes}`] : []),
    `trip page (share this link when asked for the link/plan page): ${ctx.cfg.tripLink?.(trip.code) ?? "not available"}`,
    `organizer: ${nameOf(trip, trip.organizer)}`,
    `stage: ${trip.status === "collecting_members" ? "people are still joining; the rsvp/budget/ride questions go out when the organizer texts start (the organizer can ask everyone something anytime)" : trip.status === "coordinating" ? "sorting out who's in, rides, and what to bring" : "plans have been sent"}`,
    `going: ${names(people.filter((m) => m.rsvp === "yes"))}`,
    `maybe: ${names(people.filter((m) => m.rsvp === "maybe"))}`,
    `not coming: ${names(people.filter((m) => m.rsvp === "no"))}`,
    `haven't answered yet: ${names(people.filter((m) => m.rsvp === "unknown"))}`,
  ];

  const seats = seatsNeed(trip);
  if (seats) {
    const drivers = seats.providers.map((p) => `${nameOf(trip, p)} (${trip.members[p]?.seats ?? "?"} seats)`).join(", ") || "none yet";
    lines.push(`rides: ${seats.quantityFilled} of ${seats.quantityNeeded} seats covered; drivers: ${drivers}`);
  }
  for (const n of trip.needs.filter((x) => x.kind === "item")) {
    lines.push(`${n.label}: ${n.providers.length ? `${names(n.providers.map((p) => trip.members[p]).filter(Boolean))} is bringing it` : "nobody yet"}`);
  }
  const b = budgetAnsweredCount(trip);
  const g = groupBudget(trip);
  lines.push(`group budget: ${g !== null ? `everyone's comfortable up to $${g}` : "not shared (needs 2+ answers)"}; ${b.answered} of ${b.total} answered (individual numbers are private)`);

  // Their own answers and plan.
  const own = [`you are ${me.name || "(name unknown)"}${isOrganizer ? ", the organizer" : ""}`, `your rsvp: ${me.rsvp}`];
  if (me.budgetCap !== null) own.push(`your private budget: $${me.budgetCap}`);
  if (me.canDrive) own.push(`you're driving, ${me.seats ?? "?"} seats`);
  if (me.bringing.length) own.push(`you're bringing: ${me.bringing.join(", ")}`);
  if (trip.status === "finalized") {
    const car = assignSeats(trip).cars.find((c) => c.driver === me.phone || c.riders.includes(me.phone));
    if (car) own.push(car.driver === me.phone ? `riding with you: ${names(car.riders.map((p) => trip.members[p]))}` : `you ride with ${nameOf(trip, car.driver)}`);
  }
  if (me.pendingAsk) own.push(`open question to you: ${me.pendingAsk.topic}`);
  lines.push(own.join("; "));

  if (isOrganizer) {
    // The organizer asked for these answers, so they (and only they) may see them, e.g. to find a common time.
    for (const poll of polls(trip).slice(-3)) {
      const { answers, silent } = pollResults(trip, poll);
      const to = poll.asked.length === 1 ? trip.members[poll.asked[0]]?.name ?? "someone" : "the group";
      lines.push(`your question to ${to}: "${poll.question}"`);
      for (const a of answers) lines.push(`  ${a.name} answered: ${a.answer}`);
      if (silent.length) lines.push(`  no answer yet from: ${silent.join(", ")}`);
    }
    if (trip.itinerary) {
      lines.push(`itinerary (${trip.itinerary.sentAt ? "sent to everyone" : "draft, only you've seen it"}):\n${trip.itinerary.text}`);
    } else lines.push("itinerary: not made yet");
    const notIn = people.filter((m) => (m.viaLink || m.invited) && !m.heardFrom);
    if (notIn.length) lines.push(`signed up but haven't texted in yet: ${names(notIn)}`);
  }
  return lines.join("\n");
}

/**
 * Questions the organizer's own details answer exactly ("what time are we leaving?" -> "we're leaving at 9am").
 * Code, not the model, so the answer is always the organizer's words. Null when the question isn't one of these,
 * or that detail is blank (then the normal "i'll check with <organizer>" path runs). Never invents anything.
 */
export function factAnswer(trip: Trip, text: string): string | null {
  const t = text.toLowerCase();
  const f = trip.facts ?? {};
  const where = f.where || trip.place;
  if (/\b(what time|when)\b.*\b(leav|head(ing)? out|depart|take off|go(ing)?\b|start)/.test(t) || /\bleaving at\b|\bdeparture\b/.test(t)) {
    return f.leaveAt ? `we're leaving at ${f.leaveAt}${f.meetAt ? `, meeting at ${f.meetAt}` : ""}` : null;
  }
  if (/\b(where)\b.*\b(meet|meeting|pick ?up|pickup)\b|\bmeeting spot\b|\bmeet up\b.*\?/.test(t)) {
    return f.meetAt ? `meeting at ${f.meetAt}${f.leaveAt ? `, leaving at ${f.leaveAt}` : ""}` : null;
  }
  if (/\b(what time|when)\b.*\b(back|home|return|done|end)\b|\bback by\b/.test(t)) {
    return f.backBy ? `should be back by ${f.backBy}` : null;
  }
  if (/\bwhere\b.*\b(going|headed|we going|is it|trip|at)\b/.test(t)) {
    return where ? `we're going to ${where}` : null;
  }
  if (/\b(what|anything)\b.*\b(bring|know|pack)\b/.test(t)) {
    return f.notes ? `${trip.members[trip.organizer]?.name ?? "the organizer"} says: ${f.notes}` : null;
  }
  return null;
}
