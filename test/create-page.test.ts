// The richer create-trip page: organizer facts the bot answers from, what-to-sort-out toggles, server validation.
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { startDashboard } from "../src/dashboard/server.js";
import { toDashboardView } from "../src/dashboard/view.js";
import { Engine } from "../src/engine/engine.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import type { TripFacts, TripSettings } from "../src/types.js";

const ORG = "+19195550100", SAM = "+19195550101", MAYA = "+19195550102";

async function trip(opts: { facts?: TripFacts; settings?: TripSettings; items?: string[] } = {}) {
  const store = new Store(null);
  const transport = new FakeTransport();
  const engine = new Engine({ store, transport, understand: makeUnderstander(null), phrase: makePhraser(null), cfg: { nudgeAfterMs: 1e9, giveUpAfterMs: 2e9, demoMode: true } });
  const code = await engine.createTripFromWeb({ title: "beach day", dateText: "saturday", name: "Priya", phone: ORG, ...opts });
  await engine.handleInbound(ORG, "hi Roundup! i'm Priya, planning beach day");
  for (const [p, n] of [[SAM, "Sam"], [MAYA, "Maya"]]) {
    await engine.joinFromWeb(code, { name: n, phone: p });
    await engine.handleInbound(p, `hi! i'm ${n}, joining beach day (${code})`);
  }
  transport.clear();
  return { store, transport, engine, code, t: () => Object.values(store.state.trips)[0] };
}

describe("create page: facts and settings", () => {
  it("with leaveAt set, 'what time are we leaving' is answered with it", async () => {
    const { engine, transport } = await trip({ facts: { leaveAt: "9am", meetAt: "student union parking lot" } });
    await engine.handleInbound(SAM, "what time are we leaving");
    expect(transport.to(SAM)[0]).toBe("we're leaving at 9am, meeting at student union parking lot");
  });

  it("with leaveAt empty, the answer states no time and checks with the organizer", async () => {
    const { engine, transport } = await trip();
    await engine.handleInbound(SAM, "what time are we leaving?");
    const reply = transport.to(SAM).join(" ");
    expect(reply).not.toMatch(/\d/);
    expect(reply).toMatch(/Priya/);
  });

  it("with rides off, no member is ever asked to drive", async () => {
    const { engine, transport } = await trip({ settings: { rides: false, budget: true } });
    await engine.handleInbound(ORG, "start");
    for (const p of [ORG, SAM, MAYA]) await engine.handleInbound(p, "40");
    await engine.tick();
    for (const p of [ORG, SAM, MAYA]) expect(transport.to(p).join(" ")).not.toMatch(/drive/i);
  });

  it("with budgets off, nobody is asked their budget", async () => {
    const { engine, transport } = await trip({ settings: { rides: true, budget: false } });
    await engine.handleInbound(ORG, "start");
    for (const p of [ORG, SAM, MAYA]) expect(transport.to(p).join(" ")).not.toMatch(/spend|budget/i);
  });

  it("DONE WHEN: cooler + 9am trip shows on the dashboard, answers 9am, and the cooler chain runs", async () => {
    const { engine, transport, t } = await trip({ facts: { leaveAt: "9am" }, items: ["cooler"] });
    const view = toDashboardView(t());
    expect(view.trip?.title).toBe("beach day");
    expect(view.needs.map((n) => n.label)).toContain("cooler");
    await engine.handleInbound(MAYA, "what time are we leaving");
    expect(transport.to(MAYA).at(-1)).toMatch(/9am/);
    await engine.handleInbound(ORG, "start");
    for (const p of [ORG, SAM, MAYA]) await engine.handleInbound(p, "30");
    await engine.handleInbound(ORG, "yes 5 seats"); // rides first...
    const askedCooler = [ORG, SAM, MAYA].some((p) => transport.to(p).some((x) => /cooler/.test(x)));
    expect(askedCooler).toBe(true); // ...then the cooler chain
    expect(JSON.stringify(toDashboardView(t()))).not.toMatch(/\+1919555|9195550/); // still no phone numbers
  });

  it("old trips without facts or settings still work (defaults: no facts, both on)", async () => {
    const { engine, transport, t } = await trip();
    delete t().facts; delete t().settings;
    await engine.handleInbound(ORG, "start");
    expect(transport.to(SAM).join(" ")).toMatch(/spend/);
  });
});

describe("create route validation", () => {
  const store = new Store(null);
  let created = 0;
  const dash = startDashboard({
    port: 0, getState: () => store.state, demoMode: true,
    web: { createTrip: async () => { created++; return "BEACH7"; }, join: async () => null, prepare: async () => "+14155550000", publicUrl: () => "https://x.test" },
  });
  const url = () => `http://127.0.0.1:${(dash.server.address() as AddressInfo).port}`;
  afterAll(() => dash.server.close());
  const post = (body: object) => fetch(`${url()}/api/trips`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("rejects an invalid phone number, without echoing it back", async () => {
    await new Promise((r) => setTimeout(r, 50));
    const r = await post({ title: "beach day", date: "saturday", name: "Priya", phone: "12345" });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.errors.phone).toMatch(/phone number/);
    expect(JSON.stringify(body)).not.toContain("12345");
    expect(created).toBe(0);
  });

  it("accepts common formats and the new fields", async () => {
    const r = await post({ title: "beach day", date: "saturday", name: "Priya", phone: "(919) 555-0123", facts: { leaveAt: "9am" }, rides: false, items: ["cooler"] });
    expect(r.status).toBe(200);
    expect(created).toBe(1);
  });

  it("rejects too-long fields", async () => {
    const r = await post({ title: "x".repeat(41), date: "saturday", name: "Priya", phone: "9195550123" });
    expect(r.status).toBe(400);
  });
});
