// The exact demo script from spec section 14, against the seeded trip.
import { describe, expect, it } from "vitest";
import { seatsNeed } from "../src/engine/context.js";
import { harness, isDriveQuestion } from "./helpers.js";

describe("demo script", () => {
  it("seed -> judge joins -> teammate 1 says no -> judge drives -> plans -> teammate 1 drops", async () => {
    const h = harness();
    const priya = "+19195550101", sam = "+19195550102", judge = "+19195550199";
    await h.engine.seedDemo({ organizerPhone: priya, organizerName: "Priya", memberPhone: sam, memberName: "Sam" });
    expect(h.trip().code).toBe("BEACH7");
    expect(h.transport.to(priya).some(isDriveQuestion)).toBe(true); // Priya asked first, holds her answer

    await h.say(judge, "join BEACH7");
    expect(h.transport.to(judge)[0]).toMatch(/AI helping Priya plan Beach day/);
    await h.say(judge, "Alex");
    expect(h.transport.to(judge).join(" ")).toMatch(/hey Alex!.*you in/);
    await h.say(judge, "yes!");
    await h.say(judge, "30");

    await h.say(priya, "no sorry, can't drive");
    expect(h.transport.to(judge).filter(isDriveQuestion)).toHaveLength(1);
    await h.say(judge, "yeah, i have 4 seats");
    expect(seatsNeed(h.trip())!.status).toBe("filled");
    expect(h.transport.to(sam).filter(isDriveQuestion)).toEqual([]); // never bothered

    expect(h.trip().status).toBe("finalized");
    expect(h.transport.to(judge).join(" ")).toContain("you're driving Priya and Sam");
    expect(h.transport.to(sam).join(" ")).toContain("riding with Alex");
    expect(h.transport.to(judge).join(" ")).toContain("$30");

    h.transport.clear();
    await h.say(priya, "i can't come anymore");
    expect(h.transport.to(judge).join(" ")).toMatch(/update!.*you're driving Sam\./);
    expect(h.transport.to(sam)).toEqual([]); // Sam's plan didn't change
  });
});
