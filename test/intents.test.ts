// People don't type exact commands. These are real-world phrasings that must work.
import { describe, expect, it } from "vitest";
import { findJoinCode, organizerVerb, parseTripRequest } from "../src/engine/intents.js";
import { harness, phoneFor } from "./helpers.js";

describe("loose phrasing", () => {
  it.each([
    ["New camping trip\nMaybe around saturday or sunday", "Camping trip", "saturday or sunday"],
    ["new trip Beach day on Saturday", "Beach day", "saturday"],
    ["planning a trip to asheville next weekend", "Trip to Asheville", "next weekend"],
    ["yo wanna plan a ski weekend", "Ski weekend", null],
    ["camping this saturday?", "Camping trip", "saturday"],
    ["lake day oct 18", "Lake day", "oct 18"],
  ])("%j -> %s / %s", (text, title, date) => {
    expect(parseTripRequest(text)).toEqual({ title, dateText: date });
  });

  it("ignores messages that aren't about a trip", () => {
    expect(parseTripRequest("Hello")).toBeNull();
    expect(parseTripRequest("what day is it")).toBeNull();
  });

  it("finds a code anywhere", () => {
    expect(findJoinCode("hey can i join beach7?", ["BEACH7"])).toBe("BEACH7");
    expect(findJoinCode("BEACH7", ["BEACH7"])).toBe("BEACH7");
    expect(findJoinCode("join the beach", ["BEACH7"])).toBeNull();
  });

  it("understands organizer wording", () => {
    expect(organizerVerb("let's go!")).toBe("start");
    expect(organizerVerb("where are we at?")).toBe("status");
    expect(organizerVerb("lock it in")).toBe("plan");
    expect(organizerVerb("going to the store")).toBeNull();
  });

  it("the exact message from the phone test creates a trip, and a friend joins with just the code", async () => {
    const h = harness();
    await h.say(phoneFor(0), "Hello");
    await h.say(phoneFor(0), "New camping trip\nMaybe around saturday or sunday");
    expect(h.trip().title).toBe("Camping trip");
    expect(h.trip().dateText).toBe("saturday or sunday");
    await h.say(phoneFor(0), "Krish");
    await h.say(phoneFor(1), `${h.trip().code.toLowerCase()} i'm sam`);
    expect(h.trip().members[phoneFor(1)].name).toBe("Sam");
  });
});
