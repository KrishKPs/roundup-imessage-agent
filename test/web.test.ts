// Website flow: organizer creates a trip with "+", members sign up from the trip link, and everything after
// their one-tap "hi" happens over text. Nobody is texted before they text us.
import { describe, expect, it } from "vitest";
import { harness, phoneFor } from "./helpers.js";

describe("website trip creation and trip link", () => {
  it("texts nobody until they text in, then greets each person once and runs the trip", async () => {
    const h = harness();
    const [org, sam, maya] = [phoneFor(0), phoneFor(1), phoneFor(2)];
    const code = await h.engine.createTripFromWeb({ title: "Beach day", dateText: "Saturday", name: "Krish", phone: "(919) 555-1000" });
    expect(code).toMatch(/^[A-Z0-9]{4,6}$/);
    expect(await h.engine.joinFromWeb(code, { name: "Sam", phone: "919 555 1001" })).toBe("Beach day");
    expect(await h.engine.joinFromWeb(code.toLowerCase(), { name: "Maya", phone: "+19195551002" })).toBe("Beach day");
    expect(h.transport.sent).toHaveLength(0); // shared pool can't text first, so we don't try
    expect(Object.keys(h.trip().members)).toEqual([org, sam, maya]);

    await h.say(org, "hi Roundup! i'm Krish, planning Beach day");
    expect(h.transport.to(org)).toEqual([expect.stringMatching(/hey Krish, i'm Roundup, an AI planning Beach day.*start/)]);

    await h.say(sam, `hi! i'm Sam, joining Beach day (${code})`);
    expect(h.transport.to(sam).join(" ")).toMatch(/hey Sam, i'm Roundup, an AI helping Krish plan Beach day.*stop/);

    // Sam texted in, so he's in: start goes straight to his budget. Maya hasn't texted yet: start skips her.
    expect(h.trip().members[sam].rsvp).toBe("yes");
    await h.say(org, "start");
    expect(h.transport.to(sam).at(-1)).toMatch(/spend/);
    expect(h.transport.to(maya)).toHaveLength(0);
    await h.say(maya, `hi! i'm Maya, joining Beach day (${code})`);
    expect(h.trip().members[maya].rsvp).toBe("yes");
    expect(h.transport.to(maya).join(" ")).toMatch(/AI helping Krish.*spend/s);
  });

  it("unknown codes and opted-out numbers can't join; double sign-up is harmless", async () => {
    const h = harness();
    const code = await h.engine.createTripFromWeb({ title: "Hike", dateText: null, name: "Krish", phone: phoneFor(0) });
    expect(await h.engine.joinFromWeb("NOPE1", { name: "Sam", phone: phoneFor(1) })).toBeNull();
    expect(await h.engine.joinFromWeb(code, { name: "Sam", phone: phoneFor(1) })).toBe("Hike");
    expect(await h.engine.joinFromWeb(code, { name: "Sam", phone: phoneFor(1) })).toBe("Hike");
    expect(Object.keys(h.trip().members)).toHaveLength(2);
    await h.say(phoneFor(1), "hi");
    await h.say(phoneFor(1), "stop");
    expect(await h.engine.joinFromWeb(code, { name: "Sam", phone: phoneFor(1) })).toBeNull();
  });
});
