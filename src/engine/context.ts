// What every engine module gets: the clock, settings, a way to queue outbound texts, and the trip log.
import type { LogKind, Member, MessageIntent, Phone, Trip } from "../types.js";

export interface EngineConfig {
  nudgeAfterMs: number;
  giveUpAfterMs: number;
  demoMode: boolean;
  agentNumber?: string; // E.164; enables tap-to-join links in invites
  quietToStrangers?: boolean; // local mode on a personal account: ignore non-trip texts from unknown people
  dedicatedLine?: boolean; // one number for everyone, no allowlist: join by link/QR instead of organizer adding people
  tripLink?: (code: string) => string | null; // public trip page URL, when the website is reachable
  demoChainTarget?: "real"; // demo: ask simulated non-drivers first, then real people, then simulated drivers
}

export interface Ctx {
  now(): number;
  cfg: EngineConfig;
  /** Queue a text for `phone`. Sent after the current event finishes, in order. */
  out(phone: Phone, intent: MessageIntent): void;
  log(trip: Trip, kind: LogKind, text: string): void;
}

/** Members who count as going for planning: yes, or maybe (spec 9.3). */
export function isGoing(m: Member): boolean {
  return !m.optedOut && (m.rsvp === "yes" || m.rsvp === "maybe");
}

export function goingMembers(trip: Trip): Member[] {
  return byJoin(trip).filter(isGoing);
}

/** Members sorted by join time (organizer is always first to join). */
export function byJoin(trip: Trip): Member[] {
  return Object.values(trip.members).sort((a, b) => a.joinedAt - b.joinedAt);
}

export function nameOf(trip: Trip, phone: Phone): string {
  return trip.members[phone]?.name || "someone";
}

export function organizerName(trip: Trip): string {
  return nameOf(trip, trip.organizer);
}

export function seatsNeed(trip: Trip) {
  return trip.needs.find((n) => n.kind === "seats");
}
