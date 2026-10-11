// "ask everyone ...": the organizer's question goes out 1:1 and comes back as one tally.
import { describe, expect, it } from "vitest";
import { GIVE_UP_MS, harness, phoneFor } from "./helpers.js";

async function campTrip() {
  const h = harness();
  const [org, sam, maya, leo] = [0, 1, 2, 3].map(phoneFor);
  const code = await h.engine.createTripFromWeb({ title: "CAMP", dateText: "SUNDAY", name: "Krish", phone: org });
  await h.say(org, "hi Roundup! i'm Krish, planning CAMP");
  for (const [p, n] of [[sam, "Sam"], [maya, "Maya"], [leo, "Leo"]]) {
    await h.engine.joinFromWeb(code, { name: n, phone: p });
    await h.say(p, `hi! i'm ${n}, joining CAMP (${code})`);
  }
  h.transport.clear();
  return { h, org, sam, maya, leo };
}

describe("organizer asks everyone", () => {
  it("asks each member privately, then sends the organizer one tally", async () => {
    const { h, org, sam, maya, leo } = await campTrip();
    await h.say(org, "Ask everyone does 10am Saturday works ??");
    expect(h.transport.to(org)).toEqual(["on it, asking Sam, Maya, Leo now. i'll text you once everyone answers."]);
    for (const p of [sam, maya, leo]) expect(h.transport.to(p)).toEqual(["Krish wanted to ask you: does 10am Saturday works?"]);

    await h.say(sam, "yes");
    await h.say(maya, "nah i can't make it that early");
    expect(h.trip().members[maya].rsvp).toBe("unknown"); // "can't make it that early" is an answer, not leaving the trip
    expect(h.transport.to(sam).at(-1)).toBe("got it, i'll let Krish know.");
    expect(h.transport.to(org)).toHaveLength(1); // no tally until everyone answers

    await h.say(leo, "maybe");
    expect(h.transport.to(org).at(-1)).toBe('"does 10am Saturday works?" Sam: yes; Maya: nah i can\'t make it that early; Leo: maybe');
  });

  it("reports anyway once quiet people time out", async () => {
    const { h, org, sam } = await campTrip();
    await h.say(org, "ask everyone if we should rent a canoe");
    await h.say(sam, "yep");
    h.clock.t += GIVE_UP_MS + 1000;
    await h.engine.tick();
    expect(h.transport.to(org).at(-1)).toBe('"we should rent a canoe?" Sam: yep; no answer from Maya, Leo');
  });

  it("the organizer's own free-text questions get organizer help, not the member answer", async () => {
    const { h, org } = await campTrip();
    await h.say(org, "does 10am saturday work for everyone?");
    expect(h.transport.to(org)).toEqual([expect.stringMatching(/just text "ask everyone" and your question/)]);
  });

  it("members can't poll the group", async () => {
    const { h, sam, maya } = await campTrip();
    await h.say(sam, "ask everyone if they like pizza");
    expect(h.transport.to(sam)).toEqual(["only Krish can do that one."]);
    expect(h.transport.to(maya)).toHaveLength(0);
  });

  it("open questions take any answer and report each person's words", async () => {
    const { h, org, sam, maya, leo } = await campTrip();
    await h.say(org, "ask everyone which days between saturday and tuesday are you free, and what times work best");
    expect(h.transport.to(sam)).toEqual(["Krish wanted to ask you: which days between saturday and tuesday are you free, and what times work best?"]);
    await h.say(sam, "sat after 2 or sunday all day");
    await h.say(maya, "only sunday");
    expect(h.transport.to(maya).at(-1)).toBe("got it, i'll let Krish know.");
    await h.say(leo, "sunday morning");
    expect(h.transport.to(org).at(-1)).toBe('"which days between saturday and tuesday are you free, and what times work best?" Sam: sat after 2 or sunday all day; Maya: only sunday; Leo: sunday morning');
  });

  it("a new question replaces an unanswered old one right away", async () => {
    const { h, org, sam } = await campTrip();
    await h.say(org, "ask everyone does 10am saturday work");
    await h.say(org, "ask everyone what can you bring");
    expect(h.transport.to(sam).at(-1)).toBe("Krish wanted to ask you: what can you bring?");
    await h.say(sam, "a tent and snacks");
    expect(h.trip().poll!.answers[sam]).toBe("a tent and snacks");
  });
});
