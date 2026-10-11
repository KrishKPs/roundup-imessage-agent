// toDashboardView: the ONLY place trip state becomes something public (Dashboard.md section 4.1).
// The switchboard page shows nothing that isn't in here. No phone numbers, no message text, no individual budgets.
import { goingMembers, isGoing } from "../engine/context.js";
import { newVid } from "../engine/commands.js";
import { assignSeats, budgetAnsweredCount, groupBudget } from "../engine/plan.js";
import type { Member, Need, Phone, State, Trip } from "../types.js";

type Mood = "idle" | "waiting" | "answered" | "providing" | "declined" | "dropped" | "opted_out";
type Topic = "rsvp" | "budget" | "drive" | "item" | "question" | "name" | null;

export interface DashboardView {
  trip: { title: string; dateText: string | null; code: string; status: Trip["status"]; joinLink: string | null } | null;
  members: {
    id: string; name: string; initials: string; isOrganizer: boolean; simulated: boolean;
    rsvp: Member["rsvp"]; mood: Mood; waitingOn: Topic; carId: string | null; bringing: string[];
  }[];
  needs: {
    id: string; kind: Need["kind"]; label: string; needed: number; filled: number; status: Need["status"];
    chain: { memberId: string; result: "asking" | "declined" | "providing" | "no_answer" }[];
    neverAsked: string[];
  }[];
  cars: { id: string; driverId: string; seats: number; riderIds: string[] }[];
  budget: { answered: number; going: number; groupCap: number | null };
  stats: { privateTexts: number; peopleNotBothered: number; questionsAsked: number; carsOnRoad: number; carsAvoided: number; co2SavedKg: number | null };
  feed: { at: number; kind: string; text: string; memberId: string | null }[];
  lastReply: { memberId: string; tags: string[]; exampleIds: number[] } | null;
}

export function currentTrip(state: State): Trip | undefined {
  return Object.values(state.trips).sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** The public id for a member, created once and kept with the member. */
export function vidOf(m: Member): string {
  m.vid ??= newVid();
  return m.vid;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase() || "?";
}

function topicOf(m: Member, trip: Trip): Topic {
  const t = m.pendingAsk?.topic;
  if (!t) return null;
  if (t === "seats" || t === "drive") return "drive";
  if (t === "poll") return "question";
  if (t === "item") return "item";
  return t as Topic;
}

function moodOf(m: Member, trip: Trip): Mood {
  if (m.optedOut) return "opted_out";
  if (m.droppedOut && m.rsvp === "no") return "dropped";
  if (m.pendingAsk) return "waiting";
  if (trip.needs.some((n) => n.providers.includes(m.phone))) return "providing";
  const lastAsked = [...trip.needs].reverse().find((n) => n.asked.includes(m.phone));
  if (lastAsked?.declined.includes(m.phone)) return "declined";
  if (m.rsvp !== "unknown") return "answered";
  return "idle";
}

export function toDashboardView(trip: Trip | undefined, opts: { joinLink?: string | null } = {}): DashboardView {
  const empty = { answered: 0, going: 0, groupCap: null };
  if (!trip) {
    return {
      trip: null, members: [], needs: [], cars: [], budget: empty,
      stats: { privateTexts: 0, peopleNotBothered: 0, questionsAsked: 0, carsOnRoad: 0, carsAvoided: 0, co2SavedKg: null },
      feed: [], lastReply: null,
    };
  }
  const id = (p: Phone) => (trip.members[p] ? vidOf(trip.members[p]) : "unknown");
  const members = Object.values(trip.members).sort((a, b) =>
    (a.phone === trip.organizer ? -1 : b.phone === trip.organizer ? 1 : a.joinedAt - b.joinedAt));
  const seats = assignSeats(trip);
  const carOf = new Map<Phone, string>();
  const cars = seats.cars.map((c, i) => {
    const carId = `car${i + 1}`;
    carOf.set(c.driver, carId);
    for (const r of c.riders) carOf.set(r, carId);
    return { id: carId, driverId: id(c.driver), seats: c.seats, riderIds: c.riders.map(id) };
  });

  const going = goingMembers(trip);
  const needs = trip.needs.map((n) => {
    const chain = n.asked.filter((p) => trip.members[p]).map((p) => ({
      memberId: id(p),
      result: n.providers.includes(p) ? "providing" as const : n.declined.includes(p) ? "declined" as const
        : n.waitingOn === p ? "asking" as const : "no_answer" as const,
    }));
    // Going members the chain never had to bother (only meaningful once the need is filled).
    const neverAsked = n.status === "filled"
      ? going.filter((m) => !n.asked.includes(m.phone) && !n.providers.includes(m.phone)).map((m) => vidOf(m))
      : [];
    return { id: n.id, kind: n.kind, label: n.kind === "seats" ? "Seats" : n.label, needed: n.quantityNeeded, filled: n.quantityFilled, status: n.status, chain, neverAsked };
  });

  const b = budgetAnsweredCount(trip);
  const nameToId = new Map(members.filter((m) => m.name).map((m) => [m.name.toLowerCase(), vidOf(m)]));
  return {
    trip: { title: trip.title, dateText: trip.dateText, code: trip.code, status: trip.status, joinLink: opts.joinLink ?? null },
    members: members.map((m) => ({
      id: vidOf(m), name: m.name || "new member", initials: initials(m.name || "?"), isOrganizer: m.phone === trip.organizer,
      simulated: !!m.sim, rsvp: m.rsvp, mood: moodOf(m, trip), waitingOn: topicOf(m, trip),
      carId: carOf.get(m.phone) ?? null, bringing: [...m.bringing],
    })),
    needs,
    cars,
    budget: { answered: b.answered, going: b.total, groupCap: groupBudget(trip) },
    stats: {
      privateTexts: trip.counters?.texts ?? 0,
      peopleNotBothered: needs.reduce((sum, n) => sum + n.neverAsked.length, 0),
      questionsAsked: trip.counters?.questions ?? 0,
      carsOnRoad: cars.length,
      carsAvoided: cars.length ? Math.max(0, going.filter((m) => isGoing(m)).length - cars.length) : 0,
      co2SavedKg: null,
    },
    // Engine log lines are written as plain summaries ("asked Sam to drive"), never anyone's words or budget.
    feed: trip.log.slice(-30).reverse().map((e) => {
      const first = e.text.match(/\b([A-Z][a-z]+)\b/g)?.find((w) => nameToId.has(w.toLowerCase()));
      return { at: e.at, kind: e.kind, text: e.text, memberId: first ? nameToId.get(first.toLowerCase())! : null };
    }),
    lastReply: null,
  };
}
