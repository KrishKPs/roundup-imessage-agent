// plan.md tier 1: the public Plan page data and the itinerary PDF (privacy, versions, empty and finished trips).
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { startDashboard } from "../src/dashboard/server.js";
import { pdfSafe } from "../src/dashboard/pdf.js";
import { daysUntil, itineraryItems, tripPage } from "../src/engine/itinerary.js";
import { harness, tripWithMembers } from "./helpers.js";

async function finishedTrip(title = "Beach day") {
  const h = harness();
  const p = await tripWithMembers(h, ["Priya", "Sam Rivera", "Maya"], [4173, 5281, 6007]);
  await h.say(p[0], "yes 5 seats");
  const t = h.trip();
  t.title = title;
  t.notes = [{ name: "Maya", note: "vegetarian-zq", at: 1 }];
  t.facts = { leaveAt: "9am", meetAt: "student union lot" };
  t.itinerary = { text: `${title} · saturday · Jordan Lake\n🚗 9:00 meet at student union lot\n12:00 lunch at the picnic area\nafternoon: free time by the lake`, updatedAt: 1_000_000, sentAt: 1_000_000, version: 3, changes: [{ version: 3, at: 1, summary: "lunch moved to 12" }] };
  return { h, p, t };
}

describe("plan page data", () => {
  it("public view: first names only, no phones, no individual budgets, no private notes", async () => {
    const { p, t } = await finishedTrip();
    const json = JSON.stringify(tripPage(t));
    for (const phone of p) expect(json).not.toContain(phone.slice(2));
    expect(json).not.toContain("Rivera"); // last names never
    expect(json).not.toMatch(/5281|6007/); // individual budgets (4173 is the allowed group minimum)
    expect(json).not.toContain("vegetarian-zq"); // members' private heads-ups
  });

  it("timeline items get times and kinds from the itinerary lines", () => {
    const items = itineraryItems("T · sat · X\n🚗 9:00 meet at the lot\n12:00 lunch at the park\nafternoon: free time\nswim");
    expect(items).toEqual([
      { time: "9:00", title: "meet at the lot", kind: "meet" },
      { time: "12:00", title: "lunch at the park", kind: "food" },
      { time: "afternoon", title: "free time", kind: "free" },
      { time: null, title: "swim", kind: "activity" },
    ]);
  });

  it("countdown only for real calendar dates", () => {
    const now = new Date(2026, 9, 11, 3).getTime();
    expect(daysUntil("oct 18", now)).toBe(7);
    expect(daysUntil("10/12", now)).toBe(1);
    expect(daysUntil("saturday", now)).toBeNull();
  });

  it("the PDF text is Latin-1 safe: accents kept, emoji dropped", () => {
    expect(pdfSafe("Café trip 🏖️ “fun” — yes")).toBe('Café trip "fun" - yes');
  });
});

describe("itinerary PDF route", () => {
  let state: ReturnType<typeof harness>["store"]["state"] | null = null;
  const dash = startDashboard({ port: 0, getState: () => state!, demoMode: true });
  const url = (p: string) => `http://127.0.0.1:${(dash.server.address() as AddressInfo).port}${p}`;
  afterAll(() => dash.server.close());

  it("works for an empty trip (marked draft) and a finished one (current version in the header)", async () => {
    const empty = harness();
    await empty.say("+19195550100", "new trip Café night 🌮 on saturday");
    await empty.say("+19195550100", "Priya");
    state = empty.store.state;
    await new Promise((r) => setTimeout(r, 30));
    const r1 = await fetch(url(`/t/${empty.trip().code}/itinerary.pdf`));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("application/pdf");
    expect(r1.headers.get("cache-control")).toBe("no-cache");
    const b1 = Buffer.from(await r1.arrayBuffer());
    expect(b1.subarray(0, 5).toString()).toBe("%PDF-");

    const { h, t } = await finishedTrip("Café day 🌊");
    state = h.store.state;
    const r2 = await fetch(url(`/t/${t.code}/itinerary.pdf`));
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-disposition")).toMatch(/inline; filename="caf-day-itinerary-v3\.pdf"/);
    const b2 = Buffer.from(await r2.arrayBuffer());
    expect(b2.subarray(0, 5).toString()).toBe("%PDF-");
    expect(b2.length).toBeGreaterThan(b1.length);
  });
});
