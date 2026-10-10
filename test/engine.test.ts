// Engine behavior: one question at a time, privacy, dropout, stop, handoff, restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seatsNeed } from "../src/engine/context.js";
import { harness, isDriveQuestion, phoneFor, tripWithMembers } from "./helpers.js";
import { publicView } from "../src/engine/view.js";

describe("engine", () => {
  it("3. a member with an open question does not get the drive question until it is answered", async () => {
    const h = harness();
    const p = [phoneFor(0), phoneFor(1)];
    await h.say(p[0], "new trip Beach day");
    await h.say(p[0], "Priya");
    await h.say(p[1], `join ${h.trip().code} Sam`);
    await h.say(p[0], "start"); // Priya now has an open budget question
    await h.say(p[1], "yes");   // everyone answered RSVP -> seats chain opens, Priya is first
    expect(seatsNeed(h.trip())!.waitingOn).toBe(p[0]);
    expect(h.transport.to(p[0]).some(isDriveQuestion)).toBe(false);
    await h.say(p[0], "50");
    expect(h.transport.to(p[0]).some(isDriveQuestion)).toBe(true);
  });

  it("4. a budget cap never appears in a message to a different phone", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya", "Leo"], [40, 85, 120, 73]);
    await h.say(p[0], "yes 5 seats");
    const caps = new Map(p.map((phone, i) => [phone, [40, 85, 120, 73][i]]));
    const groupMin = 40; // the one number that is shared on purpose
    for (const [owner, cap] of caps) {
      if (cap === groupMin) continue;
      for (const m of h.transport.sent) {
        if (m.phone !== owner) expect(m.text).not.toContain(String(cap));
      }
    }
    expect(h.transport.sent.some((m) => m.text.includes("$40"))).toBe(true);
    const v = publicView(h.trip());
    const view = JSON.stringify({ ...v, feed: v.feed.map((f) => f.text) }); // timestamps are not budget data
    for (const cap of [85, 120, 73]) expect(view).not.toContain(String(cap));
    expect(view).not.toContain("budgetCap");
  });

  it("5. with only one cap given, no group number is sent", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"], [null, 60, null]);
    await h.say(p[0], "yes 4 seats");
    expect(h.trip().status).toBe("finalized");
    expect(h.transport.sent.some((m) => /\$/.test(m.text))).toBe(false);
  });

  it("6. when a driver drops out, the need reopens, the next person is asked, and plans are rebuilt", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya", "Leo"]);
    await h.say(p[0], "no");
    await h.say(p[1], "yes, 4 seats");
    expect(h.trip().status).toBe("finalized");
    expect(h.transport.to(p[3]).join(" ")).toContain("riding with Sam");
    h.transport.clear();
    await h.say(p[1], "sorry i can't come anymore");
    const need = seatsNeed(h.trip())!;
    expect(need.providers).toEqual([]);
    expect(h.transport.to(p[2]).some(isDriveQuestion)).toBe(true);
    await h.say(p[2], "yes 3 seats");
    expect(h.trip().status).toBe("finalized");
    expect(h.transport.to(p[3]).join(" ")).toContain("riding with Maya");
    expect(h.transport.to(p[0]).some((t) => /Sam can't come/.test(t))).toBe(true);
  });

  it("8. after stop, the member gets exactly one confirmation and nothing else", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    h.transport.clear();
    await h.say(p[2], "stop");
    await h.say(p[2], "hello?");
    await h.say(p[0], "no");
    await h.say(p[1], "yes 3 seats");
    h.clock.t += 10 * 60_000;
    await h.engine.tick();
    expect(h.transport.to(p[2])).toHaveLength(1);
    expect(h.transport.to(p[2])[0]).toMatch(/won't hear from me/);
  });

  it("9. two unclear replies hand off to the organizer and the chain continues", async () => {
    const h = harness();
    const p = await tripWithMembers(h, ["Priya", "Sam", "Maya"]);
    await h.say(p[0], "no");
    expect(seatsNeed(h.trip())!.waitingOn).toBe(p[1]);
    await h.say(p[1], "the weather looks weird");
    expect(h.transport.to(p[1]).at(-1)).toMatch(/didn't catch that/);
    await h.say(p[1], "purple");
    expect(h.transport.to(p[1]).at(-1)).toMatch(/Priya follow up/);
    expect(h.transport.to(p[0]).some((t) => /couldn't get a clear answer from Sam/.test(t))).toBe(true);
    expect(h.trip().log.some((e) => e.kind === "handoff")).toBe(true);
    expect(h.transport.to(p[2]).some(isDriveQuestion)).toBe(true);
  });

  it("11. state survives a restart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roundup-")), "state.json");
    const h1 = harness(file);
    const p = await tripWithMembers(h1, ["Priya", "Sam", "Maya"]);
    await h1.say(p[0], "no");
    const h2 = harness(file); // fresh engine, loaded from disk
    expect(seatsNeed(h2.trip())!.waitingOn).toBe(p[1]);
    await h2.say(p[1], "yes 3 seats");
    expect(h2.trip().status).toBe("finalized");
    expect(h2.transport.to(p[2]).join(" ")).toContain("riding with Sam");
  });
});
