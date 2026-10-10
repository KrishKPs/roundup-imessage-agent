// Seat assignment must be deterministic so the plan never surprises anyone.
import { describe, expect, it } from "vitest";
import { newNeed } from "../src/engine/chain.js";
import { newMember } from "../src/engine/commands.js";
import { assignSeats, groupBudget } from "../src/engine/plan.js";
import type { Trip } from "../src/types.js";

function fixedTrip(): Trip {
  const names = ["Priya", "Sam", "Maya", "Leo", "Jo", "Ana", "Kai"];
  const members = Object.fromEntries(
    names.map((n, i) => {
      const m = newMember(`+1555000000${i}`, n, i);
      m.rsvp = "yes";
      return [m.phone, m];
    }),
  );
  const seats = newNeed("seats", "seats", 7);
  members["+15550000002"].seats = 4; // Maya drives, 4 seats
  members["+15550000004"].seats = 3; // Jo drives, 3 seats
  seats.providers = ["+15550000002", "+15550000004"];
  return {
    id: "t", code: "BEACH7", title: "Beach day", dateText: null, organizer: "+15550000000",
    status: "coordinating", members, needs: [seats], log: [], createdAt: 0, startedAt: 0,
  };
}

describe("plan", () => {
  it("10. seat assignment is deterministic", () => {
    const plan = assignSeats(fixedTrip());
    expect(plan.cars).toEqual([
      { driver: "+15550000002", seats: 4, riders: ["+15550000000", "+15550000001", "+15550000005"] },
      { driver: "+15550000004", seats: 3, riders: ["+15550000003", "+15550000006"] },
    ]);
    expect(plan.unassigned).toEqual([]);
    expect(assignSeats(fixedTrip())).toEqual(plan);
  });

  it("group budget is hidden with fewer than 2 caps", () => {
    const t = fixedTrip();
    t.members["+15550000001"].budgetCap = 50;
    expect(groupBudget(t)).toBeNull();
    t.members["+15550000003"].budgetCap = 30;
    expect(groupBudget(t)).toBe(30);
  });
});
