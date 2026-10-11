// The chained-asking algorithm (spec 9.3). Asks one person at a time and stops the moment a need is filled.
import type { Member, Need, ParsedReply, Phone, Trip } from "../types.js";
import { newId } from "../util.js";
import { MAX_UNANSWERED, cancelAsksFor, enqueueAsk } from "./asks.js";
import { type Ctx, isGoing, byJoin, goingMembers, organizerName, seatsNeed } from "./context.js";

export function newNeed(kind: Need["kind"], label: string, quantityNeeded: number): Need {
  return {
    id: newId(kind), kind, label, quantityNeeded, quantityFilled: 0,
    candidates: [], asked: [], declined: [], providers: [],
    status: "open", waitingOn: null, shortNotified: null,
  };
}

/**
 * Who to ask, in order. Seats: organizer, then anyone who mentioned a car, then by join time.
 * Items: organizer, then by join time, with drivers moved to the back so the work is spread out.
 */
export function candidateOrder(trip: Trip, need: Need): Phone[] {
  const all = byJoin(trip);
  const org = all.filter((m) => m.phone === trip.organizer);
  const rest = all.filter((m) => m.phone !== trip.organizer);
  let ordered: Member[];
  if (need.kind === "seats") {
    ordered = [...org, ...rest.filter((m) => m.carHint), ...rest.filter((m) => !m.carHint)];
  } else {
    const drivers = new Set(seatsNeed(trip)?.providers ?? []);
    ordered = [...org, ...rest.filter((m) => !drivers.has(m.phone)), ...rest.filter((m) => drivers.has(m.phone))];
    const orgIsDriver = org.length && drivers.has(trip.organizer);
    if (orgIsDriver) ordered = [...ordered.slice(1), ordered[0]];
  }
  return ordered.map((m) => m.phone);
}

function eligible(trip: Trip, need: Need, phone: Phone): boolean {
  const m = trip.members[phone];
  if (!m || m.optedOut || m.rsvp !== "yes") return false;
  if (need.asked.includes(phone)) return false;
  if (m.sentSinceReply >= MAX_UNANSWERED) return false; // not answering us right now
  if (need.kind === "seats" && m.canDrive === false) return false; // already told us they can't
  if (need.kind === "item" && need.providers.includes(phone)) return false;
  return true;
}

/** Seats needed = everyone going (yes or maybe). Call whenever an RSVP changes. */
export function recomputeSeats(trip: Trip): void {
  const need = seatsNeed(trip);
  if (need) need.quantityNeeded = goingMembers(trip).length;
}

export function runChain(ctx: Ctx, trip: Trip, need: Need): void {
  need.candidates = candidateOrder(trip, need);

  if (need.quantityFilled >= need.quantityNeeded && need.quantityNeeded > 0) {
    if (need.waitingOn) {
      const m = trip.members[need.waitingOn];
      need.waitingOn = null;
      if (m) cancelAsksFor(ctx, trip, m, need.id);
    }
    if (need.status !== "filled") {
      need.status = "filled";
      need.shortNotified = null;
      ctx.log(trip, "need_filled", need.kind === "seats"
        ? `seats covered: ${need.quantityFilled} for ${need.quantityNeeded} people`
        : `${need.label} covered`);
    }
    return;
  }

  if (need.waitingOn) return; // sequential: wait for the current person

  let next = need.candidates.find((p) => eligible(trip, need, p));
  if (!next && need.kind === "seats") {
    // Nobody else can: go back to a backup driver, once.
    const backup = need.declined.find((p) => {
      const b = trip.members[p];
      return b?.backupDriver && !b.backupAsked && !b.optedOut && isGoing(b);
    });
    if (backup) {
      const b = trip.members[backup];
      b.backupAsked = true;
      b.canDrive = null;
      need.declined = need.declined.filter((p) => p !== backup);
      next = backup;
      ctx.log(trip, "asked", `going back to ${b.name}, the backup driver`);
    }
  }
  if (!next) {
    const missing = Math.max(0, need.quantityNeeded - need.quantityFilled);
    if (missing === 0) return; // nothing needed yet (e.g. nobody going)
    if (need.status !== "short" || need.shortNotified !== missing) {
      need.status = "short";
      need.shortNotified = missing;
      const unit = need.kind === "seats" ? (missing === 1 ? "seat" : "seats") : "";
      ctx.out(trip.organizer, {
        kind: "short_organizer",
        label: need.kind === "seats" ? trip.title : `the ${need.label}`,
        missing,
        unit: unit || (missing === 1 ? "person" : "people"),
      });
      ctx.log(trip, "need_short", need.kind === "seats"
        ? `${missing} ${unit} short, told ${organizerName(trip)}`
        : `nobody has a ${need.label} yet, told ${organizerName(trip)}`);
    }
    return;
  }

  need.status = "open";
  need.asked.push(next);
  need.waitingOn = next;
  enqueueAsk(ctx, trip, trip.members[next], need.kind === "seats" ? "drive" : "item", need.id);
}

export type ChainAnswer = "provided" | "declined" | "backup" | "need_seat_count" | "ignored";

/** Apply someone's answer to a drive/seats/item question. Late answers (after we moved on) still count. */
export function applyChainAnswer(ctx: Ctx, trip: Trip, need: Need, m: Member, parsed: ParsedReply): ChainAnswer {
  if (need.waitingOn === m.phone) need.waitingOn = null;
  if (need.kind === "seats") {
    if (parsed.backup && !m.backupAsked) {
      // Willing as a last resort: count them out for now, come back only if nobody else can drive.
      m.canDrive = false;
      m.backupDriver = true;
      if (!need.declined.includes(m.phone)) need.declined.push(m.phone);
      ctx.log(trip, "answered", `${m.name} can drive as a backup`);
      return "backup";
    }
    if (parsed.canDrive === false) {
      m.canDrive = false;
      if (!need.declined.includes(m.phone)) need.declined.push(m.phone);
      ctx.log(trip, "answered", `${m.name} can't drive`);
      return "declined";
    }
    if (parsed.canDrive && parsed.seats === null) {
      m.canDrive = true;
      need.waitingOn = m.phone; // keep the chain on them for the seat count
      return "need_seat_count";
    }
    if (parsed.seats !== null && parsed.seats >= 1) {
      if (need.providers.includes(m.phone)) need.quantityFilled -= m.seats ?? 0;
      else need.providers.push(m.phone);
      m.canDrive = true;
      m.seats = parsed.seats;
      need.quantityFilled += parsed.seats;
      need.declined = need.declined.filter((p) => p !== m.phone);
      ctx.log(trip, "answered", `${m.name} has ${parsed.seats} ${parsed.seats === 1 ? "seat" : "seats"}`);
      return "provided";
    }
    return "ignored";
  }
  // item
  if (parsed.itemYes) {
    if (need.quantityFilled >= need.quantityNeeded) return "ignored"; // someone else already has it
    need.providers.push(m.phone);
    need.quantityFilled += 1;
    m.bringing.push(need.label);
    ctx.log(trip, "answered", `${m.name} is bringing a ${need.label}`);
    return "provided";
  }
  if (parsed.itemYes === false) {
    if (!need.declined.includes(m.phone)) need.declined.push(m.phone);
    ctx.log(trip, "answered", `${m.name} can't bring a ${need.label}`);
    return "declined";
  }
  return "ignored";
}

/** Remove everything a member was providing (dropout, or "actually i can't drive"). Reopens the needs. */
export function releaseCommitments(ctx: Ctx, trip: Trip, m: Member, onlyKind?: Need["kind"]): string[] {
  const released: string[] = [];
  for (const need of trip.needs) {
    if (onlyKind && need.kind !== onlyKind) continue;
    if (need.waitingOn === m.phone) {
      need.waitingOn = null;
      cancelAsksFor(ctx, trip, m, need.id);
    }
    if (!need.providers.includes(m.phone)) continue;
    need.providers = need.providers.filter((p) => p !== m.phone);
    need.quantityFilled -= need.kind === "seats" ? (m.seats ?? 0) : 1;
    if (need.kind === "item") m.bringing = m.bringing.filter((b) => b !== need.label);
    need.status = "open";
    need.shortNotified = null;
    released.push(need.kind === "seats" ? "car" : need.label);
  }
  return released;
}
