// Replays the real phone conversation that went wrong on Oct 10 (5:38 PM).
import { describe, expect, it } from "vitest";
import { harness, phoneFor } from "./helpers.js";

describe("real conversation regressions", () => {
  it("a question is never taken as a name, acks get no reply, nothing repeats, and names can be fixed", async () => {
    const h = harness();
    const hasti = phoneFor(0), krish = phoneFor(1);
    await h.say(hasti, "New camping trip, maybe around saturday or sunday");
    await h.say(hasti, "Hasti");
    await h.say(krish, `join ${h.trip().code}`);
    expect(h.transport.to(krish).at(-1)).toMatch(/what's your first name/);

    await h.say(krish, "So what's the plan ?"); // the "Krish" reply was lost; this must not become the name
    expect(h.trip().members[krish].name).toBe("");
    expect(h.transport.to(krish).at(-2)).toMatch(/Hasti's planning Camping trip \(saturday or sunday\)/);
    expect(h.transport.to(hasti).some((t) => /has a question/.test(t))).toBe(false); // basic question, no ping

    await h.say(krish, "Krish");
    expect(h.trip().members[krish].name).toBe("Krish");
    const before = h.transport.to(krish).length;
    await h.say(krish, "Okay");
    await h.say(krish, "Sounds good");
    expect(h.transport.to(krish)).toHaveLength(before); // no reply to acks

    await h.say(krish, "my name is Kris");
    expect(h.trip().members[krish].name).toBe("Kris");
    await h.say(krish, "blah");
    await h.say(krish, "blah blah");
    const texts = h.transport.to(krish);
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
  });
});
