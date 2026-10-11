// Crowd mode (Dashboard.md 10 + acceptance checks 1-4): simulated members are labeled, never texted for real,
// answer with replies from the reference conversations, and the seats chain hops and stops.
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDashboardView } from "../src/dashboard/view.js";
import { Engine } from "../src/engine/engine.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Crowd, loadBank } from "../src/sim/crowd.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";

afterEach(() => vi.useRealTimers());

describe("crowd mode", () => {
  it("the reply bank comes from the reference conversations, labeled by what our parser reads", () => {
    const bank = loadBank();
    expect(bank["rsvp:yes"]?.length).toBeGreaterThan(20);
    expect(bank["drive:no"]?.length).toBeGreaterThan(10);
  });

  it("seed + 12 sims: labeled, never sent through the real transport, chain hops and stops", async () => {
    vi.useFakeTimers();
    const store = new Store(null);
    const real = new FakeTransport();
    const crowd = new Crowd(store);
    const engine = new Engine({
      store, transport: crowd.wrap(real), understand: makeUnderstander(null), phrase: makePhraser(null),
      cfg: { nudgeAfterMs: 120_000, giveUpAfterMs: 240_000, demoMode: true, demoChainTarget: "real" },
    });
    crowd.engine = engine;
    await engine.seedDemo({ organizerPhone: "sim:organizer", organizerName: "Priya", memberPhone: "sim:mate", memberName: "Sam" });
    await engine.addCrowd(crowd.nextNames(12, new Set(["Priya", "Sam"])), (p) => crowd.personaFor(p).canDrive);
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      await engine.tick();
    }
    const trip = Object.values(store.state.trips)[0];
    const view = toDashboardView(trip);
    expect(view.members).toHaveLength(14);
    expect(view.members.every((m) => m.simulated)).toBe(true);
    expect(real.sent).toHaveLength(0); // nothing ever went to Photon
    const seats = view.needs.find((n) => n.kind === "seats")!;
    expect(seats.chain.length).toBeGreaterThanOrEqual(2); // it hopped
    expect(["filled", "short"]).toContain(seats.status);
    if (seats.status === "filled") expect(view.stats.peopleNotBothered).toBe(seats.neverAsked.length);
    expect(view.stats.privateTexts).toBeGreaterThan(20);
    expect(view.budget.answered).toBeGreaterThan(1);
  });
});
