// Dashboard.md section 12 rule 7: the switchboard snapshot never contains phones, message text, or individual budgets.
import { describe, expect, it } from "vitest";
import { toDashboardView } from "../src/dashboard/view.js";
import { harness, tripWithMembers } from "./helpers.js";

describe("switchboard snapshot privacy", () => {
  it("has no phone numbers, no message text, no individual budgets", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"], [4173, 5281, null]);
    await h.say(p[1], "purple elephant question about the trip?");
    const view = toDashboardView(h.trip());
    const json = JSON.stringify(view);
    for (const phone of p) {
      expect(json).not.toContain(phone);
      expect(json).not.toContain(phone.slice(2)); // without the +1
    }
    // The group minimum (4173, from 2 answers) is the one budget number allowed, and only in budget.groupCap.
    expect(view.budget.groupCap).toBe(4173);
    expect(JSON.stringify({ ...view, budget: null })).not.toContain("4173");
    expect(json).not.toContain("5281");
    expect(json).not.toContain("purple elephant");
  });

  it("group cap stays hidden until 2 going members answered; ids are stable and not phone-based", async () => {
    const h = harness();
    await tripWithMembers(h, ["Priya", "Sam", "Maya"], [6007, null, null]);
    const v1 = toDashboardView(h.trip());
    expect(v1.budget).toEqual({ answered: 1, going: 3, groupCap: null });
    const v2 = toDashboardView(h.trip());
    expect(v2.members.map((m) => m.id)).toEqual(v1.members.map((m) => m.id));
    expect(v1.members[0].isOrganizer).toBe(true);
    expect(v1.stats.privateTexts).toBeGreaterThan(0);
  });

  it("counts people the chain never had to bother once a need is filled", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya", "Leo"]);
    await h.say(p[0], "yes 5 seats");
    const v = toDashboardView(h.trip());
    const seats = v.needs.find((n) => n.kind === "seats")!;
    expect(seats.status).toBe("filled");
    expect(seats.neverAsked).toHaveLength(3);
    expect(v.stats.peopleNotBothered).toBe(3);
    expect(v.cars).toHaveLength(1);
  });
});
