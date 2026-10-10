// The dashboard-safe view of a trip: names, statuses, and progress only.
// Never includes budget caps or full phone numbers (spec 10.1 and 10.6).
import type { Need, Trip } from "../types.js";
import { maskPhone } from "../util.js";
import { budgetAnsweredCount, groupBudget } from "./plan.js";

export type ChainMark = "providing" | "said_no" | "asked" | "not_asked";

export interface PublicTrip {
  title: string;
  dateText: string | null;
  code: string;
  status: Trip["status"];
  organizer: string;
  members: { name: string; phone: string; status: "in" | "out" | "maybe" | "waiting" | "opted_out" }[];
  needs: {
    label: string;
    kind: Need["kind"];
    filled: number;
    needed: number;
    status: Need["status"];
    chain: { name: string; mark: ChainMark }[];
  }[];
  budget: { answered: number; total: number; groupMax: number | null };
  feed: { at: number; kind: string; text: string }[];
}

export function publicView(trip: Trip): PublicTrip {
  const name = (p: string) => trip.members[p]?.name || "new member";
  return {
    title: trip.title,
    dateText: trip.dateText,
    code: trip.code,
    status: trip.status,
    organizer: name(trip.organizer),
    members: Object.values(trip.members)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({
        name: m.name || "new member",
        phone: maskPhone(m.phone),
        status: m.optedOut ? "opted_out" : m.rsvp === "yes" ? "in" : m.rsvp === "no" ? "out" : m.rsvp === "maybe" ? "maybe" : "waiting",
      })),
    needs: trip.needs.map((n) => ({
      label: n.kind === "seats" ? "Seats" : n.label,
      kind: n.kind,
      filled: n.quantityFilled,
      needed: n.quantityNeeded,
      status: n.status,
      chain: n.candidates
        .filter((p) => trip.members[p] && !trip.members[p].optedOut && trip.members[p].rsvp === "yes" || n.asked.includes(p))
        .map((p) => ({
          name: name(p),
          mark: n.providers.includes(p) ? "providing" : n.declined.includes(p) ? "said_no" : n.asked.includes(p) ? "asked" : "not_asked",
        })),
    })),
    budget: { ...budgetAnsweredCount(trip), groupMax: groupBudget(trip) },
    feed: trip.log.slice(-10).reverse(),
  };
}
