// What the AI may know when it talks to one person: trip facts, plus that person's OWN answers.
// Never another member's budget, never anyone's phone number. The AI may only say what is in here.
import type { Member, Trip } from "../types.js";
import { type Ctx, byJoin, nameOf, seatsNeed } from "./context.js";
import { pollSummary } from "./poll.js";
import { assignSeats, budgetAnsweredCount, groupBudget } from "./plan.js";

const names = (ms: Member[]) => ms.map((m) => m.name || "someone").join(", ") || "nobody";

export function factsFor(trip: Trip, me: Member, ctx: Ctx): string {
  const people = byJoin(trip).filter((m) => !m.optedOut);
  const isOrganizer = me.phone === trip.organizer;
  const lines = [
    `trip: ${trip.title}`,
    `date: ${trip.dateText ?? "not set yet"}`,
    `organizer: ${nameOf(trip, trip.organizer)}`,
    `stage: ${trip.status === "collecting_members" ? "people are still joining; questions start when the organizer says start" : trip.status === "coordinating" ? "sorting out who's in, rides, and what to bring" : "plans have been sent"}`,
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
    if (trip.poll) lines.push(`your question to everyone: ${pollSummary(trip)}`);
    const notIn = people.filter((m) => (m.viaLink || m.invited) && !m.heardFrom);
    if (notIn.length) lines.push(`signed up but haven't texted in yet: ${names(notIn)}`);
  }
  lines.push(`now: ${new Date(ctx.now()).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}`);
  return lines.join("\n");
}
