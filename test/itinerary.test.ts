// Itinerary: drafted from what the bot collected, edited by the organizer over text, sent with a trip page link.
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { itineraryFacts, tripPage } from "../src/engine/itinerary.js";
import { checkItinerary, type ItineraryInput } from "../src/llm/itinerary.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import { phoneFor } from "./helpers.js";

async function campTrip(writer?: (i: ItineraryInput) => Promise<string | null>) {
  const transport = new FakeTransport();
  const store = new Store(null);
  const engine = new Engine({
    store, transport, understand: makeUnderstander(null), phrase: makePhraser(null),
    cfg: { nudgeAfterMs: 1e9, giveUpAfterMs: 2e9, demoMode: true, tripLink: (c) => `https://roundup.test/t/${c}` },
    writeItinerary: writer,
  });
  const [org, sam, maya] = [0, 1, 2].map(phoneFor);
  const code = await engine.createTripFromWeb({ title: "Beach day", dateText: "saturday 12pm", name: "Krish", phone: org });
  await engine.handleInbound(org, "hi Roundup! i'm Krish, planning Beach day");
  for (const [p, n] of [[sam, "Sam"], [maya, "Maya"]]) {
    await engine.joinFromWeb(code, { name: n, phone: p });
    await engine.handleInbound(p, `hi! i'm ${n}, joining Beach day (${code})`);
  }
  const trip = Object.values(store.state.trips)[0];
  for (const p of [sam, maya]) trip.members[p].rsvp = "yes";
  trip.members[sam].budgetCap = 55;
  trip.members[maya].budgetCap = 40;
  transport.clear();
  return { engine, transport, trip, org, sam, maya, code };
}

describe("itinerary", () => {
  it("asks where they're headed, drafts it for the organizer only, then sends everyone their plan + the trip page", async () => {
    const { engine, transport, trip, org, sam, maya, code } = await campTrip();
    await engine.handleInbound(org, "make the itinerary");
    expect(transport.to(org)).toEqual(["on it! where are you all headed?"]);
    await engine.handleInbound(org, "Jordan Lake");
    expect(trip.place).toBe("Jordan Lake");
    expect(transport.to(org).at(-1)).toMatch(/^draft's ready:\n\nBeach day · saturday 12pm · Jordan Lake\n/);
    expect(transport.to(org).at(-1)).toContain("budget: everyone's good up to $40");
    expect(transport.to(sam)).toHaveLength(0); // draft is the organizer's until they send it
    expect(tripPage(trip).itinerary).toBeNull();

    await engine.handleInbound(org, "looks good, send it");
    expect(transport.to(sam).join(" ")).toContain(`plan's ready: https://roundup.test/t/${code}`);
    expect(transport.to(maya).join(" ")).toContain("here's your plan for Beach day");
    expect(transport.to(org).at(-1)).toBe(`sent to 2 people! the trip page: https://roundup.test/t/${code}`);
    const page = tripPage(trip);
    expect(page.itinerary).toContain("Jordan Lake");
    expect(JSON.stringify({ ...page, updatedAt: null })).not.toMatch(/\b55\b|\+1919/); // no individual budgets, no phone numbers
  });

  it("the organizer edits by text, and a re-send only tells people the plan changed", async () => {
    let calls = 0;
    const writer = async (i: ItineraryInput) => {
      calls += 1;
      return i.change ? "Beach day · saturday 1pm · Jordan Lake\n1:00 meet at Krish's\nswim + lunch" : "Beach day · saturday 12pm · Jordan Lake\n12:00 meet at Krish's\nswim + lunch";
    };
    const { engine, transport, trip, org, sam } = await campTrip(writer);
    await engine.handleInbound(org, "we're going to Jordan Lake");
    await engine.handleInbound(org, "make the itinerary");
    expect(transport.to(org).at(-1)).toContain("12:00 meet at Krish's");
    await engine.handleInbound(org, "send it");
    // An edit through the conversation layer would call makeItinerary(trip, change); exercise it via the place change:
    await engine.handleInbound(org, "place: Jordan Lake north beach");
    expect(calls).toBe(2);
    expect(transport.to(org).at(-1)).toMatch(/^updated draft:\n\n/);
    await engine.handleInbound(org, "send it");
    expect(transport.to(sam).at(-1)).toMatch(/^small change: now saturday 1pm, Jordan Lake\. updated plan: /);
    expect(trip.itinerary?.text).toContain("1:00");
    expect(trip.dateText).toBe("saturday 1pm"); // the edit moved the time, so the trip moved with it
  });

  it("the writer only sees the group budget and heads-ups, never anyone's own budget", async () => {
    const { trip } = await campTrip();
    trip.notes = [{ name: "Maya", note: "allergic to peanuts", at: 1 }];
    const facts = itineraryFacts(trip);
    expect(facts).toContain("group budget: everyone's comfortable up to $40");
    expect(facts).not.toContain("allergic to peanuts"); // heads-ups are private: the writer only learns that some exist
    expect(facts).toContain("1 private heads-up(s) went to the organizer");
    expect(facts).not.toContain("55");
  });

  it("checks reject made-up prices, made-up people, and notes-to-self", () => {
    const input: ItineraryInput = { facts: "trip: Beach day\nplace: Jordan Lake\ngoing: Sam, Maya", draft: null, change: null, names: ["Krish", "Sam", "Maya"], budget: 40 };
    const ok = "Beach day · Sat · Jordan Lake\n12:00 meet up, Sam drives Maya\nswim + lunch\nbudget: up to $40";
    expect(checkItinerary(ok, input)).toBe(ok);
    expect(checkItinerary(`${ok}\nparking is $15`, input)).toBeNull();
    expect(checkItinerary(`${ok}\nJessica brings chairs`, input)).toBeNull();
    expect(checkItinerary(`${ok}\nwait, let me fix the times`, input)).toBeNull();
  });
});
