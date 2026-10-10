// Finalizing (spec 9.6): seat assignment, the group budget number, and each person's plan text.
import type { Phone, Trip } from "../types.js";
import { clip, listNames } from "../util.js";
import { type Ctx, goingMembers, nameOf, seatsNeed } from "./context.js";

export interface Car {
  driver: Phone;
  seats: number; // total including the driver
  riders: Phone[];
}

export interface SeatPlan {
  cars: Car[];
  unassigned: Phone[];
}

/** Greedy and deterministic: drivers take themselves, riders go in join order to the car with the most free seats. */
export function assignSeats(trip: Trip): SeatPlan {
  const going = goingMembers(trip);
  const goingSet = new Set(going.map((m) => m.phone));
  const providers = seatsNeed(trip)?.providers ?? [];
  const cars: Car[] = providers
    .filter((p) => goingSet.has(p))
    .map((p) => ({ driver: p, seats: trip.members[p].seats ?? 1, riders: [] }));
  const drivers = new Set(cars.map((c) => c.driver));
  const unassigned: Phone[] = [];
  for (const m of going) {
    if (drivers.has(m.phone)) continue;
    let best: Car | null = null;
    for (const car of cars) {
      const free = car.seats - 1 - car.riders.length;
      if (free > 0 && (!best || free > best.seats - 1 - best.riders.length)) best = car;
    }
    if (best) best.riders.push(m.phone);
    else unassigned.push(m.phone);
  }
  return { cars, unassigned };
}

/** Lowest budget among people going. Hidden unless at least 2 people shared one (so nobody is identifiable). */
export function groupBudget(trip: Trip): number | null {
  const caps = goingMembers(trip).map((m) => m.budgetCap).filter((c): c is number => c !== null);
  return caps.length >= 2 ? Math.min(...caps) : null;
}

export function budgetAnsweredCount(trip: Trip): { answered: number; total: number } {
  const going = goingMembers(trip);
  return { answered: going.filter((m) => m.budgetCap !== null).length, total: going.length };
}

/** Up to 2 messages: logistics, then what to bring and the budget. */
export function planFor(trip: Trip, phone: Phone, seats: SeatPlan, budget: number | null): string[] {
  const m = trip.members[phone];
  const header = `here's your plan for ${trip.title}${trip.dateText ? ` (${trip.dateText})` : ""}: `;
  const car = seats.cars.find((c) => c.driver === phone);
  const ride = seats.cars.find((c) => c.riders.includes(phone));
  let ridePart: string;
  if (car && car.riders.length) ridePart = `you're driving ${listNames(car.riders.map((p) => nameOf(trip, p)))}.`;
  else if (car) ridePart = "you're driving, no riders.";
  else if (ride) ridePart = `you're riding with ${nameOf(trip, ride.driver)}.`;
  else ridePart = `still sorting out your ride, ${nameOf(trip, trip.organizer)} knows.`;
  if (m.rsvp === "maybe") ridePart += " (planned like you're in)";

  const extras: string[] = [];
  if (m.bringing.length) extras.push(`please bring the ${listNames(m.bringing)}.`);
  if (budget !== null) extras.push(`everyone's comfortable up to $${budget}.`);
  const msgs = [clip(header + ridePart)];
  if (extras.length) msgs.push(clip(extras.join(" ")));
  return msgs;
}

/** The organizer's full summary. Longer than 160 chars on purpose: it is the one roster message. */
export function organizerSummary(trip: Trip, seats: SeatPlan, budget: number | null): string {
  const going = goingMembers(trip);
  const lines = [`${trip.title} plan: ${going.length} going (${going.map((m) => m.name).join(", ")}).`];
  if (seats.cars.length) {
    const cars = seats.cars.map((c) => `${nameOf(trip, c.driver)}${c.riders.length ? ` + ${c.riders.map((p) => nameOf(trip, p)).join(", ")}` : ""}`);
    lines.push(`cars: ${cars.join("; ")}.`);
  }
  for (const need of trip.needs.filter((n) => n.kind === "item")) {
    lines.push(`${need.label}: ${need.providers.length ? need.providers.map((p) => nameOf(trip, p)).join(", ") : "nobody yet"}.`);
  }
  if (budget !== null) lines.push(`budget: everyone's ok up to $${budget}.`);
  const short: string[] = [];
  if (seats.unassigned.length) short.push(`rides for ${listNames(seats.unassigned.map((p) => nameOf(trip, p)))}`);
  for (const need of trip.needs) if (need.kind === "item" && need.status !== "filled") short.push(`a ${need.label}`);
  if (short.length) lines.push(`still missing: ${short.join(", ")}.`);
  return lines.join(" ");
}

/**
 * Build every plan and send it only to people whose plan text changed since last time.
 * The first call sends everyone their plan; later calls (after a dropout) send only updates.
 */
export function finalize(ctx: Ctx, trip: Trip): void {
  const first = trip.status !== "finalized" && !Object.values(trip.members).some((m) => m.lastPlan);
  trip.status = "finalized";
  const seats = assignSeats(trip);
  const budget = groupBudget(trip);
  const going = new Set(goingMembers(trip).map((m) => m.phone));
  let changed = 0;

  for (const m of Object.values(trip.members)) {
    if (m.phone === trip.organizer || m.optedOut) continue;
    if (!going.has(m.phone)) {
      m.lastPlan = null;
      continue;
    }
    const msgs = planFor(trip, m.phone, seats, budget);
    const text = msgs.join("\n");
    if (text === m.lastPlan) continue;
    const toSend = m.lastPlan ? [clip(`update! ${msgs[0]}`), ...msgs.slice(1)] : msgs;
    for (const t of toSend) ctx.out(m.phone, { kind: "text", text: t });
    m.lastPlan = text;
    changed += 1;
  }

  const org = trip.members[trip.organizer];
  const summary = organizerSummary(trip, seats, budget);
  if (org && !org.optedOut && summary !== org.lastPlan) {
    ctx.out(org.phone, { kind: "text", text: summary });
    org.lastPlan = summary;
  }
  if (first) ctx.log(trip, "finalized", `plans sent to ${going.size} people`);
  else if (changed) ctx.log(trip, "finalized", `plan updated for ${changed} ${changed === 1 ? "person" : "people"}`);
}
