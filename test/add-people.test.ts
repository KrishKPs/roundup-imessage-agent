// Organizer adds friends by sharing contact cards or typing numbers; Roundup invites each one.
import { describe, expect, it } from "vitest";
import { parsePeople } from "../src/engine/intents.js";
import { harness, phoneFor } from "./helpers.js";

describe("organizer adds people", () => {
  it("parses typed numbers with names", () => {
    expect(parsePeople("Sam 704-555-1234, maya (919) 555 0000\n+1 415 555 9999")).toEqual([
      { name: "Sam", phone: "704-555-1234" },
      { name: "Maya", phone: "(919) 555 0000" },
      { name: null, phone: "+1 415 555 9999" },
    ]);
  });

  it("contact cards: each person gets one invite that says it's an AI, organizer gets a confirmation", async () => {
    const h = harness();
    const org = phoneFor(0);
    await h.say(org, "camping trip saturday");
    await h.say(org, "Krish");
    expect(h.transport.to(org).at(-1)).toMatch(/who's coming\? type their names and numbers here/);
    expect(h.transport.to(org).join(" ")).not.toContain("sms:"); // no invite link on a shared line
    await h.engine.handleContacts(org, [{ name: "Sam", phone: "(704) 555-1001" }, { name: "Maya", phone: "+19195551002" }]);
    const sam = "+17045551001";
    expect(h.transport.to(sam)).toHaveLength(1);
    expect(h.transport.to(sam)[0]).toMatch(/hey Sam, Krish added you to Camping trip \(saturday\).*AI.*stop/);
    expect(h.transport.to(org).at(-1)).toMatch(/added Sam and Maya/);
    expect(h.trip().members[sam].invited).toBe(true);

    // start: invitees get the RSVP question like anyone else
    await h.say(org, "let's go");
    expect(h.transport.to(sam).at(-1)).toMatch(/you in for Camping trip/);
  });

  it("typed numbers work too; nameless people are asked their name without a second intro", async () => {
    const h = harness();
    const org = phoneFor(0);
    await h.say(org, "new trip Beach day on Saturday");
    await h.say(org, "Priya");
    await h.say(org, "add 704 555 1003");
    const p = "+17045551003";
    expect(h.transport.to(p)).toEqual([
      expect.stringMatching(/^hey, Priya added you to Beach day/),
      "what's your first name, by the way?",
    ]);
    await h.say(p, "jo");
    expect(h.transport.to(p).at(-1)).toMatch(/nice to meet you Jo/);
    expect(h.transport.to(p).join(" ")).not.toMatch(/hey Jo, i'm Roundup/);
  });

  it("never re-adds someone who said stop, and only the organizer can add", async () => {
    const h = harness();
    const org = phoneFor(0);
    await h.say(org, "beach day saturday");
    await h.say(org, "Priya");
    await h.engine.handleContacts(org, [{ name: "Sam", phone: phoneFor(1) }]);
    await h.say(phoneFor(1), "stop");
    const before = h.transport.to(phoneFor(1)).length;
    await h.engine.handleContacts(org, [{ name: "Sam", phone: phoneFor(1) }]);
    expect(h.transport.to(phoneFor(1))).toHaveLength(before);
    await h.engine.handleContacts(phoneFor(2), [{ name: "X", phone: phoneFor(3) }]);
    expect(h.transport.to(phoneFor(3))).toEqual([]);
  });
});

describe("re-adding", () => {
  it("re-sharing someone who never replied re-sends their invite; once they reply, it's skipped", async () => {
    const h = harness();
    const org = phoneFor(0);
    await h.say(org, "camping trip saturday");
    await h.say(org, "Hasti");
    await h.engine.handleContacts(org, [{ name: "Khush", phone: phoneFor(5) }]);
    h.transport.clear();
    await h.engine.handleContacts(org, [{ name: "Khush", phone: phoneFor(5) }]);
    expect(h.transport.to(phoneFor(5))).toHaveLength(1);
    expect(h.transport.to(phoneFor(5))[0]).toMatch(/Hasti added you/);
    await h.say(phoneFor(5), "hi!");
    h.transport.clear();
    await h.engine.handleContacts(org, [{ name: "Khush", phone: phoneFor(5) }]);
    expect(h.transport.to(phoneFor(5))).toEqual([]);
  });
});

describe("invite can't be delivered", () => {
  it("tells the organizer the truth and the invitee's bot number; texting first gets them a proper welcome", async () => {
    const h = harness();
    const org = phoneFor(0), khush = "+17045552194";
    const realSend = h.transport.send.bind(h.transport);
    h.transport.send = async (phone, text) => {
      if (phone === khush && !blocked.done) throw new Error("[spectrum-imessage] Target not allowed for this project");
      return realSend(phone, text);
    };
    const blocked = { done: false };
    (h.transport as unknown as { lineFor: (p: string) => string }).lineFor = () => "+16282647648";
    await h.say(org, "camping trip saturday");
    await h.say(org, "Hasti");
    await h.engine.handleContacts(org, [{ name: "Khush", phone: khush }]);
    expect(h.transport.to(org).join(" ")).toMatch(/hey Khush, i'm planning .* text "hi" to \+16282647648 to join/);

    blocked.done = true; // inbound always works: Khush texts the bot first
    await h.say(khush, "hi");
    expect(h.transport.to(khush)[0]).toMatch(/hey Khush, Hasti added you to Camping trip/);
  });
});
