// plan.md tier 2: organizer setup interview, member preferences, draft -> approve -> publish, change notices.
import { describe, expect, it } from "vitest";
import { interviewAnswer } from "../src/engine/prefs.js";
import { Engine } from "../src/engine/engine.js";
import { tripPage } from "../src/engine/itinerary.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import type { TripFacts } from "../src/types.js";

const ORG = "+19195550100", SAM = "+19195550101", MAYA = "+19195550102";

async function setup(facts: TripFacts = {}) {
  const store = new Store(null);
  const transport = new FakeTransport();
  const engine = new Engine({ store, transport, understand: makeUnderstander(null), phrase: makePhraser(null),
    cfg: { nudgeAfterMs: 1e9, giveUpAfterMs: 2e9, demoMode: true, tripLink: (c) => `https://r.test/t/${c}` } });
  const code = await engine.createTripFromWeb({ title: "Beach day", dateText: "saturday", name: "Priya", phone: ORG, facts, settings: { rides: false, budget: false } });
  await engine.handleInbound(ORG, "hi Roundup! i'm Priya, planning Beach day");
  const t = () => Object.values(store.state.trips)[0];
  return { engine, transport, t, code };
}

async function withMembers(facts: TripFacts = { where: "Jordan Lake", leaveAt: "9am", backBy: "8pm" }) {
  const s = await setup(facts);
  for (const [p, n] of [[SAM, "Sam"], [MAYA, "Maya"]] as const) {
    await s.engine.joinFromWeb(s.code, { name: n, phone: p });
    await s.engine.handleInbound(p, `hi! i'm ${n}, joining Beach day (${s.code})`);
  }
  return s;
}

describe("organizer setup interview", () => {
  it("skips what the create page already answered", async () => {
    const { transport } = await setup({ where: "Jordan Lake", leaveAt: "9am", backBy: "8pm" });
    const qs = transport.to(ORG).join(" | ");
    expect(qs).not.toMatch(/headed|where's the trip|where are we going|what time do you want|rough times/);
    expect(qs).toMatch(/vibe|chill/); // first unanswered question is the vibe
  });

  it("reads answers, 'skip' moves on, 'done' stops with a one-text recap", async () => {
    const { engine, transport, t } = await setup();
    await engine.handleInbound(ORG, "jordan lake");
    expect(t().facts?.where).toBe("jordan lake");
    await engine.handleInbound(ORG, "leave at 9am back by 8pm");
    expect([t().facts?.leaveAt, t().facts?.backBy]).toEqual(["9am", "8pm"]);
    await engine.handleInbound(ORG, "skip"); // vibe
    expect(t().prefs?.vibe).toBeUndefined();
    await engine.handleInbound(ORG, "done");
    expect(t().prefs?.interviewDone).toBe(true);
    expect(transport.to(ORG).at(-1)).toMatch(/^got it: jordan lake, 9am-8pm.*draft a plan for you to approve/);
    const before = transport.to(ORG).length;
    await engine.handleInbound(ORG, "lol ok");
    expect(transport.to(ORG).slice(before).join(" ")).not.toMatch(/vibe|must-dos|avoid|pack the day/);
  });
});

describe("member preferences, draft, publish, changes", () => {
  async function prefsAnswered() {
    const s = await withMembers();
    await s.engine.handleInbound(ORG, "chill"); // vibe
    await s.engine.handleInbound(ORG, "done");
    await s.engine.handleInbound(ORG, "start");
    await s.engine.tick();
    return s;
  }

  it("members get the two questions after logistics; constraints never leak anywhere", async () => {
    const { engine, transport, t } = await prefsAnswered();
    expect(transport.to(SAM).join(" ")).toMatch(/hoping to do|make the day|really want to do/);
    await engine.handleInbound(SAM, "swimming and views");
    expect(transport.to(SAM).at(-1)).toMatch(/only i see this/);
    await engine.handleInbound(SAM, "im vegetarian-zq7 and cant do long walks");
    expect(t().members[SAM].prefs?.interests).toEqual(["swimming", "views"]);
    expect(t().members[SAM].prefs?.constraints).toEqual(["dietary", "mobility"]);
    expect(JSON.stringify(tripPage(t()))).not.toContain("zq7");
    for (const p of [ORG, MAYA]) expect(transport.to(p).join(" ")).not.toMatch(/zq7|vegetarian/);
  });

  it("drafts after half answered, nothing reaches members until 'yes', then a change texts only the affected", async () => {
    const { engine, transport, t } = await prefsAnswered();
    await engine.handleInbound(SAM, "swimming");
    await engine.handleInbound(SAM, "nah");
    await engine.tick(); // half of the people going answered -> first draft
    expect(t().itinerary).toBeTruthy();
    expect(transport.to(ORG).at(-1)).toMatch(/^draft's ready:.*look good\? say yes or tell me what to change/s);
    const samBefore = transport.to(SAM).length;
    expect(transport.to(MAYA).join(" ")).not.toMatch(/draft|plan's ready/); // draft is the organizer's only

    await engine.handleInbound(ORG, "yes");
    expect(t().itinerary?.version).toBe(1);
    expect(transport.to(SAM).slice(samBefore).join(" ")).toContain("plan's ready: https://r.test/t/");

    // a change after approval: version 2, a change line, the organizer is told
    t().itinerary!.text += "\nsunset: bonfire";
    await engine.handleInbound(ORG, "send it");
    expect(t().itinerary?.version).toBe(2);
    expect(t().itinerary?.changes?.at(-1)?.summary).toBe("sunset: bonfire");
    expect(transport.to(ORG).at(-1)).toMatch(/^v2 is out: sunset: bonfire/);
  });
});

describe("setup interview takes undecided answers", () => {
  it("'maybe hiking or camping whatever others are comfortable with' is an answer, not a reask", () => {
    const trip: any = { facts: {}, prefs: {} };
    expect(interviewAnswer(trip, "where", "Maybe hiking or camping whatever others are comfortable with")).toBe("next");
    expect(trip.prefs.vibe).toBe("hiking or camping");
    expect(trip.facts.where).toBeUndefined();
  });
});
