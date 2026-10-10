// Chained asking: stops when filled, reports shortfalls, and moves on after silence.
import { describe, expect, it } from "vitest";
import { seatsNeed } from "../src/engine/context.js";
import { GIVE_UP_MS, NUDGE_MS, harness, isDriveQuestion, tripWithMembers } from "./helpers.js";

describe("seats chain", () => {
  it("1. stops asking the moment seats are filled", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya", "Leo", "Jo", "Ana"]);
    expect(h.transport.to(p[0]).some(isDriveQuestion)).toBe(true);
    await h.say(p[0], "no");       // member 1 declines
    await h.say(p[1], "yes 4 seats"); // member 2: 4 seats
    await h.say(p[2], "4");        // member 3: 4 seats -> 8 >= 6
    expect(seatsNeed(h.trip())!.status).toBe("filled");
    for (const phone of p.slice(3)) {
      expect(h.transport.to(phone).filter(isDriveQuestion)).toEqual([]);
    }
  });

  it("2. tells the organizer the exact shortfall once when nobody can drive", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    await h.say(p[0], "no");
    await h.say(p[1], "nope");
    await h.say(p[2], "nah");
    const need = seatsNeed(h.trip())!;
    expect(need.status).toBe("short");
    const shortMsgs = h.transport.to(p[0]).filter((t) => /short/.test(t));
    expect(shortMsgs).toHaveLength(1);
    expect(shortMsgs[0]).toContain("3 seats short");
  });

  it("7. nudges exactly once, then the chain moves to the next person", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    h.transport.clear();
    h.clock.t += NUDGE_MS + 1000;
    await h.engine.tick();
    h.clock.t += 15_000;
    await h.engine.tick(); // still only one nudge
    expect(h.transport.to(p[0]).filter((t) => /no rush/.test(t))).toHaveLength(1);
    expect(h.transport.to(p[1]).some(isDriveQuestion)).toBe(false);
    h.clock.t += GIVE_UP_MS;
    await h.engine.tick();
    expect(h.transport.to(p[0]).filter((t) => /no rush/.test(t))).toHaveLength(1);
    expect(h.transport.to(p[1]).some(isDriveQuestion)).toBe(true);
  });
});
