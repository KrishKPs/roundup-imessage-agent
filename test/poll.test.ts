// "ask everyone ...": the organizer's question goes out 1:1 and comes back as one tally.
import { describe, expect, it } from "vitest";
import { summarizeAnswers } from "../src/engine/poll.js";
import { GIVE_UP_MS, NUDGE_MS, harness, phoneFor } from "./helpers.js";

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
    expect(h.transport.to(org)).toEqual(["on it, asking Sam, Maya, Leo. i'll text you once everyone answers."]);
    for (const p of [sam, maya, leo]) expect(h.transport.to(p)).toEqual(["Krish wanted to ask you: does 10am Saturday works?"]);

    await h.say(sam, "yes");
    await h.say(maya, "nah i can't make it that early");
    expect(h.trip().members[maya].rsvp).toBe("yes"); // joined = in; "can't make it that early" is an answer, not leaving
    expect(h.transport.to(sam).at(-1)).toBe("got it, i'll let Krish know");
    expect(h.transport.to(org)).toHaveLength(1); // no tally until everyone answers

    await h.say(leo, "maybe");
    expect(h.transport.to(org).at(-1)).toBe('heard back on "does 10am Saturday works": Sam said yes, Leo said maybe, Maya said "nah i can\'t make it that early"');
  });

  it("reports anyway once quiet people time out", async () => {
    const { h, org, sam } = await campTrip();
    await h.say(org, "ask everyone if we should rent a canoe");
    await h.say(sam, "yep");
    h.clock.t += GIVE_UP_MS + 1000;
    await h.engine.tick();
    expect(h.transport.to(org).at(-1)).toBe('Sam said yes to "we should rent a canoe". no answer from Maya and Leo');
  });

  it("the organizer's own free-text questions get organizer help, not the member answer", async () => {
    const { h, org } = await campTrip();
    await h.say(org, "does 10am saturday work for everyone?");
    expect(h.transport.to(org)[0]).toMatch(/just text "ask everyone" and your question/);
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
    expect(h.transport.to(maya).at(-1)).toBe("got it, i'll let Krish know");
    await h.say(leo, "sunday morning");
    expect(h.transport.to(org).at(-1)).toBe('heard back on "which days between saturday and tuesday are you free, and what times work best": Sam said "sat after 2 or sunday all day", Maya said "only sunday", Leo said "sunday morning"');
  });

  it("a second question waits its turn, and both get answered and reported", async () => {
    const { h, org, sam } = await campTrip();
    await h.say(org, "ask everyone does 10am saturday work");
    await h.say(org, "ask everyone what can you bring");
    expect(h.transport.to(sam)).toEqual(["Krish wanted to ask you: does 10am saturday work?"]); // one question at a time
    await h.say(sam, "yep");
    expect(h.transport.to(sam).at(-1)).toBe("Krish wanted to ask you: what can you bring?");
    await h.say(sam, "a tent and snacks");
    const [first, second] = h.trip().polls!;
    expect([first.answers[sam], second.answers[sam]]).toEqual(["yep", "a tent and snacks"]);
  });

  it("ask just Sam: only Sam is asked, and the organizer hears back what Sam said", async () => {
    const { h, org, sam, maya, leo } = await campTrip();
    await h.say(org, "ask sam if he can bring the tent");
    expect(h.transport.to(org)).toEqual(["on it, asking Sam. i'll let you know what Sam says."]);
    expect(h.transport.to(sam)).toEqual(["Krish wanted to ask you: can you bring the tent?"]);
    expect(h.transport.to(maya)).toHaveLength(0);
    expect(h.transport.to(leo)).toHaveLength(0);
    await h.say(sam, "yeah i got one");
    expect(h.transport.to(org).at(-1)).toBe('Sam can bring the tent, said "yeah i got one"');
  });

  it("a nudge repeats the actual question, never a context-free 'no rush'", async () => {
    const { h, org, sam } = await campTrip();
    await h.say(org, "ask sam if he can bring the tent");
    h.clock.t += NUDGE_MS + 1000;
    await h.engine.tick();
    expect(h.transport.to(sam).at(-1)).toBe("hey Sam, no rush. can you bring the tent?");
  });

  it("ask two people: one summary once both answer; a typo in a name still finds them", async () => {
    const { h, org, sam, maya, leo } = await campTrip();
    await h.say(org, "ask Sam and Myaa what time they get off work");
    expect(h.transport.to(org)).toEqual(["on it, asking Sam and Maya. i'll text you once they've both answered."]);
    expect(h.transport.to(maya)).toEqual(["Krish wanted to ask you: what time you get off work?"]);
    expect(h.transport.to(leo)).toHaveLength(0);
    await h.say(sam, "5ish");
    expect(h.transport.to(org)).toHaveLength(1);
    await h.say(maya, "around 6");
    expect(h.transport.to(org).at(-1)).toBe('heard back on "what time you get off work": Sam said "5ish", Maya said "around 6"');
  });

  it("tell just Leo: only Leo gets the note", async () => {
    const { h, org, sam, leo } = await campTrip();
    await h.say(org, "tell Leo to bring the speaker");
    expect(h.transport.to(leo)).toEqual(["from Krish: bring the speaker"]);
    expect(h.transport.to(sam)).toHaveLength(0);
    expect(h.transport.to(org)).toEqual(["sent to Leo."]);
  });

  it("a group question keeps going while a 1:1 question is asked", async () => {
    const { h, org, sam, maya } = await campTrip();
    await h.say(org, "ask everyone which day works");
    await h.say(org, "ask Maya if she can drive");
    await h.say(sam, "sunday");
    await h.say(maya, "sunday too");
    expect(h.transport.to(maya).at(-1)).toBe("Krish wanted to ask you: can you drive?");
    await h.say(maya, "yes i can");
    expect(h.transport.to(org).join(" | ")).toContain("Maya can drive");
    expect(h.trip().polls!.map((p) => p.reported)).toEqual([false, true]); // Leo hasn't answered the group one
  });

  it("notes are written to the person: 'he's on speaker duty' -> 'you're on speaker duty'", async () => {
    const { h, org, leo, maya } = await campTrip();
    await h.say(org, "let leo know hes on speaker duty");
    expect(h.transport.to(leo)).toEqual(["from Krish: you're on speaker duty"]);
    await h.say(org, "tell everyone they need to bring their own water");
    expect(h.transport.to(maya)).toEqual(["from Krish: you need to bring your own water"]);
  });

  it("answers to 'are you coming?' count as RSVPs, so the trip page shows who's going", async () => {
    const { h, org, sam, maya, leo } = await campTrip();
    await h.say(org, "ask everyone are you coming to CAMP on sunday");
    await h.say(sam, "Yess");
    await h.say(maya, "No");
    await h.say(leo, "Yes I will be there");
    const t = h.trip();
    expect([t.members[sam].rsvp, t.members[maya].rsvp, t.members[leo].rsvp]).toEqual(["yes", "no", "yes"]);
  });
});

describe("poll summaries read like a person wrote them", () => {
  it("one yes to a 'down for' question", () => {
    expect(summarizeAnswers("would you be down for camping", true, [{ name: "Hasti", answer: "Yes" }], [])).toBe("Hasti's down for camping");
  });
  it("one no to a 'can you' question", () => {
    expect(summarizeAnswers("can you bring the speaker?", true, [{ name: "Sam", answer: "nah" }], [])).toBe("Sam can't bring the speaker");
  });
});

describe("emoji and undecided answers", () => {
  it("a tent emoji to 'hiking or camping' reads as camping", () => {
    expect(summarizeAnswers("would you be down for hiking or camping?", true, [{ name: "Hasti", answer: "⛺" }], [])).toBe("Hasti picked camping ⛺");
  });
  it("a thumbs up is a yes", () => {
    expect(summarizeAnswers("would you be down for camping", true, [{ name: "Hasti", answer: "👍" }], [])).toBe("Hasti's down for camping");
  });
});
