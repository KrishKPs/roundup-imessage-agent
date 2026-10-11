// Patterns from the team's 500 reference conversations: backup drivers and RSVPs with a catch.
import { describe, expect, it } from "vitest";
import { seatsNeed } from "../src/engine/context.js";
import { rsvpCondition } from "../src/engine/engine.js";
import { harness, isDriveQuestion, tripWithMembers } from "./helpers.js";

describe("from the reference conversations", () => {
  it("'id rather not but i can if no one else does' -> backup; asked again only when nobody else can drive", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    await h.say(p[0], "id rather not but i can if no one else does");
    expect(h.transport.to(p[0]).at(-1)).toBe("got it, you're my backup. i'll try others first");
    await h.say(p[1], "no car sorry");
    await h.say(p[2], "nah");
    expect(h.transport.to(p[0]).at(-1)).toBe("turns out nobody else can drive, so i need you after all. how many seats do you have?");
    expect(seatsNeed(h.trip())!.status).not.toBe("short");
    await h.say(p[0], "5");
    expect(seatsNeed(h.trip())!.status).toBe("filled");
  });

  it("a backup who's never needed is never asked again", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    await h.say(p[0], "id rather not but i can if no one else does");
    await h.say(p[1], "yeah 4 seats");
    expect(seatsNeed(h.trip())!.status).toBe("filled");
    expect(h.transport.to(p[0]).filter(isDriveQuestion)).toHaveLength(1);
  });

  it("'yeah as long as were back by 8' -> in, and the organizer hears the catch", async () => {
    const h = harness();
    const org = "+19195551000";
    await h.say(org, "new trip Lake day on saturday");
    await h.say(org, "Priya");
    const code = h.trip().code;
    const kai = "+19195551001";
    await h.say(kai, `join ${code} Kai`);
    await h.say(org, "start");
    await h.say(kai, "yeah as long as were back by 8");
    expect(h.trip().members[kai].rsvp).toBe("yes");
    expect(h.transport.to(kai).slice(-2)).toEqual(["noted, i'll flag that to Priya", "what's the most you'd wanna spend? nobody sees it but me"]);
    expect(h.transport.to(org).join(" | ")).toContain("heads up from Kai: as long as were back by 8");
    expect(h.trip().notes?.[0].note).toBe("as long as were back by 8");
  });

  it("finds the catch, and ignores plain yeses and money", () => {
    expect(rsvpCondition("fine but im not waking up before 9")).toBe("but im not waking up before 9");
    expect(rsvpCondition("yeah i can")).toBeNull();
    expect(rsvpCondition("yes but only if it's under $20")).toBeNull();
  });
});
