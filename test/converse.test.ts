// The conversation layer with a scripted fake model: Gemini picks the action, code runs it and checks the words.
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { makeConverser } from "../src/llm/converse.js";
import type { Llm } from "../src/llm/gemini.js";
import { isSafeRewrite, makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import { phoneFor } from "./helpers.js";

/** A fake model: the converse prompt gets `next`, every other prompt fails (so templates/keywords are used). */
function fakeLlm() {
  const llm = { next: "{}", prompts: [] as string[] } as Llm & { next: string; prompts: string[] };
  llm.generate = async (prompt: string) => {
    llm.prompts.push(prompt);
    if (prompt.includes("Pick exactly one action")) return llm.next;
    throw new Error("not scripted");
  };
  return llm;
}

async function setup() {
  const llm = fakeLlm();
  const transport = new FakeTransport();
  const store = new Store(null);
  const clock = { t: 1_000_000 };
  const engine = new Engine({
    store, transport, understand: makeUnderstander(llm), phrase: makePhraser(llm),
    cfg: { nudgeAfterMs: 120_000, giveUpAfterMs: 240_000, demoMode: true }, now: () => clock.t,
    converse: makeConverser(llm),
  });
  const [org, sam, maya] = [0, 1, 2].map(phoneFor);
  const code = await engine.createTripFromWeb({ title: "CAMP", dateText: "sunday", name: "Krish", phone: org });
  await engine.handleInbound(org, "hi Roundup! i'm Krish, planning CAMP");
  for (const [p, n] of [[sam, "Sam"], [maya, "Maya"]]) {
    await engine.joinFromWeb(code, { name: n, phone: p });
    await engine.handleInbound(p, `hi! i'm ${n}, joining CAMP (${code})`);
  }
  transport.clear();
  const say = (p: string, text: string, model: object) => {
    llm.next = JSON.stringify({ question: null, items: null, date: null, reply: null, ...model });
    clock.t += 1000;
    return engine.handleInbound(p, text);
  };
  return { engine, transport, store, llm, org, sam, maya, say };
}

describe("talking like a person", () => {
  it("organizer in plain English: a question for the group becomes a 1:1 poll", async () => {
    const { transport, org, sam, maya, say } = await setup();
    await say(org, "does 10am saturday work for everyone?", { action: "ask_everyone", question: "does 10am saturday work for you?" });
    expect(transport.to(org)).toEqual(["on it, asking Sam, Maya now. i'll text you once everyone answers."]);
    expect(transport.to(sam)[0]).toMatch(/quick q from Krish: does 10am saturday work for you\?/);
    expect(transport.to(maya)).toHaveLength(1);
  });

  it("organizer changes the date in plain English", async () => {
    const { transport, store, org, say } = await setup();
    await say(org, "lets do it saturday instead", { action: "set_date", date: "saturday" });
    expect(Object.values(store.state.trips)[0].dateText).toBe("saturday");
    expect(transport.to(org).at(-1)).toBe("done, CAMP is now saturday.");
  });

  it("member questions are answered from trip facts, and the facts never include others' budgets", async () => {
    const { transport, llm, sam, say, store } = await setup();
    Object.values(store.state.trips)[0].members[phoneFor(2)].budgetCap = 77;
    await say(sam, "who else is coming?", { action: "reply", reply: "so far it's you, Maya and Krish!" });
    expect(transport.to(sam)).toEqual(["so far it's you, Maya and Krish!"]);
    const prompt = llm.prompts.find((p) => p.includes("Pick exactly one action"))!;
    expect(prompt).toContain("trip: CAMP");
    expect(prompt).not.toContain("77");
  });

  it("made-up numbers are rejected and the safe fallback is used", async () => {
    const { transport, sam, say } = await setup();
    await say(sam, "what time do we leave?", { action: "reply", reply: "we leave at 7am sharp" });
    expect(transport.to(sam).join(" ")).not.toContain("7am");
    expect(transport.to(sam)[0]).toMatch(/Krish's planning CAMP/);
  });

  it("questions the facts can't answer go to the organizer only, as a short summary", async () => {
    const { transport, org, sam, maya, say } = await setup();
    await say(sam, "should i bring my own sleeping bag?", { action: "pass_to_organizer", note: "should they bring their own sleeping bag?", reply: "good q, i'll check with Krish!" });
    expect(transport.to(sam)).toEqual(["good q, i'll check with Krish!"]);
    expect(transport.to(org).at(-1)).toBe("Sam asked: should they bring their own sleeping bag? text them back when you get a sec.");
    expect(transport.to(maya)).toHaveLength(0);
  });

  it("FYIs reach the organizer, but a note with money in it falls back to the generic heads-up", async () => {
    const { transport, org, sam, say, store } = await setup();
    await say(sam, "i might be 30 min late", { action: "tell_organizer", note: "might be 30 min late", reply: "no worries, i'll tell Krish." });
    expect(transport.to(org).at(-1)).toBe("heads up from Sam: might be 30 min late");
    Object.values(store.state.trips)[0].members[sam].budgetCap = 40;
    await say(sam, "can we keep it under 40", { action: "pass_to_organizer", note: "can it stay under $40?", reply: "i'll ask Krish." });
    expect(transport.to(org).at(-1)).toMatch(/Sam has a question/);
    expect(transport.to(org).join(" ")).not.toContain("40");
  });

  it("members can't trigger organizer actions through the model", async () => {
    const { transport, store, sam, maya, say } = await setup();
    await say(sam, "move it to monday", { action: "set_date", date: "monday", reply: null });
    expect(Object.values(store.state.trips)[0].dateText).toBe("sunday");
    expect(transport.to(maya)).toHaveLength(0);
  });

  it("rewrites must keep the AI disclosure, stop option, trip name, and the single question", () => {
    const draft = "hey Sam! i'm Roundup, an AI helping Krish plan CAMP. reply stop anytime.";
    const intent = { kind: "intro", name: "Sam", trip: "CAMP", organizer: "Krish" } as const;
    expect(isSafeRewrite(draft, "yo Sam! roundup here, an AI helping Krish with CAMP. text stop to opt out", intent)).toBe(true);
    expect(isSafeRewrite(draft, "yo Sam! helping Krish with CAMP. text stop to opt out", intent)).toBe(false);
    expect(isSafeRewrite(draft, "yo Sam! an AI helping Krish plan the trip, text stop anytime", intent)).toBe(false);
    expect(isSafeRewrite("are you in? yes or no", "you in? or nah?", undefined)).toBe(false);
  });
});
