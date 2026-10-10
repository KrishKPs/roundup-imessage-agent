// Builds the demo trip (spec 14): "Beach day", code BEACH7, two teammates already in.
// The organizer is asked to drive right away; the second teammate already told us they have no car,
// so the chain goes organizer -> the judge, and the second teammate is never bothered.
import type { Trip } from "../types.js";
import { normalizePhone } from "../util.js";
import { newMember } from "./commands.js";
import type { Ctx } from "./context.js";

export interface SeedInput {
  organizerPhone: string;
  organizerName: string;
  memberPhone: string;
  memberName: string;
}

export function buildDemoTrip(ctx: Ctx, input: SeedInput): Trip {
  const now = ctx.now();
  const org = newMember(normalizePhone(input.organizerPhone), input.organizerName, now - 2000);
  org.rsvp = "yes";
  org.budgetCap = 60;
  const mate = newMember(normalizePhone(input.memberPhone), input.memberName, now - 1000);
  mate.rsvp = "yes";
  mate.budgetCap = 45;
  mate.canDrive = false; // told us earlier: no car
  const trip: Trip = {
    id: `trip_demo_${now}`, code: "BEACH7", title: "Beach day", dateText: "Saturday",
    organizer: org.phone, status: "coordinating",
    members: { [org.phone]: org, [mate.phone]: mate },
    needs: [], log: [], createdAt: now, startedAt: now,
  };
  ctx.log(trip, "joined", `${org.name} started Beach day`);
  ctx.log(trip, "joined", `${mate.name} joined`);
  ctx.log(trip, "answered", `${org.name} and ${mate.name} are in`);
  return trip;
}
