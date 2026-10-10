// Test harness: an engine on the fake transport with a controllable clock and keyword-only parsing.
import { Engine } from "../src/engine/engine.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import type { Trip } from "../src/types.js";

export const NUDGE_MS = 120_000;
export const GIVE_UP_MS = 240_000;

export function phoneFor(i: number): string {
  return `+1919555${String(1000 + i).slice(-4)}`;
}

export function harness(file: string | null = null) {
  const clock = { t: 1_000_000 };
  const transport = new FakeTransport();
  const store = new Store(file);
  const engine = new Engine({
    store,
    transport,
    understand: makeUnderstander(null),
    phrase: makePhraser(null),
    cfg: { nudgeAfterMs: NUDGE_MS, giveUpAfterMs: GIVE_UP_MS, demoMode: true },
    now: () => clock.t,
  });
  const say = async (phone: string, text: string) => {
    clock.t += 1000;
    await engine.handleInbound(phone, text);
  };
  const trip = (): Trip => Object.values(store.state.trips)[0];
  return { engine, transport, store, clock, say, trip };
}

/**
 * Organizer (index 0) creates a trip and n-1 members join and RSVP yes with a budget.
 * The organizer's budget is answered too. Returns phones in join order.
 */
export async function tripWithMembers(h: ReturnType<typeof harness>, names: string[], budgets?: (number | null)[]) {
  const phones = names.map((_, i) => phoneFor(i));
  await h.say(phones[0], "new trip Beach day on Saturday");
  await h.say(phones[0], names[0]);
  const code = h.trip().code;
  for (let i = 1; i < names.length; i++) await h.say(phones[i], `join ${code} ${names[i]}`);
  await h.say(phones[0], "start");
  const b = budgets ?? names.map(() => null);
  await h.say(phones[0], b[0] === null ? "skip" : String(b[0]));
  for (let i = 1; i < names.length; i++) {
    await h.say(phones[i], "yes");
    await h.say(phones[i], b[i] === null ? "skip" : String(b[i]));
  }
  return phones;
}

export const isDriveQuestion = (t: string) => /drive|seats in your car/i.test(t);
