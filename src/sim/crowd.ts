// Crowd mode (Dashboard.md section 10): simulated members so the switchboard shows the real scale (15-20 people)
// with only a few phones. Simulated members have ids like "sim:3", are always labeled "sim", and are NEVER texted:
// SimTransport swallows messages to them and, after a delay, answers with a real-sounding reply taken from the
// team's 500 reference conversations, fed back through engine.handleInbound like any real text.
import fs from "node:fs";
import type { Engine } from "../engine/engine.js";
import { keywordParse } from "../llm/understand.js";
import type { Store } from "../store.js";
import type { Transport } from "../transport/transport.js";
import type { AskTopic, Phone } from "../types.js";

export interface Persona {
  rsvp: "yes" | "maybe" | "no";
  canDrive: boolean;
  seats: number;
  budgetCap: number;
  hasItems: boolean;
  replyDelayMs: number;
  slow: boolean; // never replies (shows the nudge)
}

/** Small seeded random generator (mulberry32), so demo runs are repeatable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePersona(rand: () => number): Persona {
  const r = rand();
  return {
    rsvp: r < 0.7 ? "yes" : r < 0.85 ? "maybe" : "no",
    canDrive: rand() < 0.25,
    seats: rand() < 0.5 ? 4 : 5,
    budgetCap: [15, 20, 25, 30, 40, 50, 60][Math.floor(rand() * 7)],
    hasItems: rand() < 0.3,
    replyDelayMs: 2000 + Math.floor(rand() * 5000),
    slow: rand() < 0.1,
  };
}

// ---------------------------------------------------------------- reply bank from the reference conversations

type Bank = Record<string, string[]>; // key: "<topic>:<answer>" e.g. "drive:no", "rsvp:yes"

/** Topic of a Roundup question in the reference set, by its wording. */
function topicOfQuestion(t: string): AskTopic | null {
  if (/spend|budget/.test(t)) return "budget";
  if (/seats/.test(t)) return "seats";
  if (/drive|a car/.test(t)) return "drive";
  if (/bring|do you have a|got a/.test(t)) return "item";
  if (/(you in|down for|make it|you free|coming|can you make)/.test(t)) return "rsvp";
  return null;
}

/** Build the bank: each member reply that directly followed a Roundup question, labeled by what it means. */
export function loadBank(file = "human_conversations_500.jsonl"): Bank {
  const bank: Bank = {};
  if (!fs.existsSync(file)) return bank;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const conv = JSON.parse(line) as { turns: { from: string; text: string }[] };
    for (let i = 0; i + 1 < conv.turns.length; i++) {
      const q = conv.turns[i], a = conv.turns[i + 1];
      if (q.from !== "roundup" || a.from !== "them" || !q.text.includes("?")) continue;
      const topic = topicOfQuestion(q.text.toLowerCase());
      if (!topic) continue;
      // Keep only replies our own parser reads confidently, labeled with what it read (spec: confidence >= 0.9).
      const p = keywordParse(a.text, topic === "seats" ? "seats" : topic);
      if (p.confidence < 0.9) continue;
      let answer: string | null = null;
      if (topic === "rsvp") answer = p.rsvp;
      else if (topic === "drive") answer = p.backup ? null : p.canDrive === true ? "yes" : p.canDrive === false ? "no" : null;
      else if (topic === "item") answer = p.itemYes === true ? "yes" : p.itemYes === false ? "no" : null;
      else if (topic === "budget") answer = p.budgetCap !== null ? "number" : null;
      if (!answer) continue;
      (bank[`${topic}:${answer}`] ??= []).push(a.text);
    }
  }
  return bank;
}

/** What this persona says to a question on `topic`. */
export function replyFor(persona: Persona, topic: AskTopic, bank: Bank, rand: () => number): string | null {
  const pick = (key: string, fallback: string) => {
    const list = bank[key];
    return list?.length ? list[Math.floor(rand() * list.length)] : fallback;
  };
  switch (topic) {
    case "rsvp": return pick(`rsvp:${persona.rsvp}`, persona.rsvp);
    case "budget": return String(persona.budgetCap); // numbers in the bank are other people's budgets; use the persona's
    case "drive": return persona.canDrive ? `yeah ${persona.seats} seats` : pick("drive:no", "no");
    case "seats": return String(persona.seats);
    case "item": return persona.hasItems ? pick("item:yes", "yes") : pick("item:no", "no");
    case "name": return null;
    case "poll": return pick(`rsvp:${persona.rsvp}`, "works for me");
  }
}

const NAMES = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Faye", "Gus", "Hana", "Ivy", "Jon", "Kira", "Luca", "Mila", "Nico", "Omar", "Pia", "Quinn", "Rosa", "Theo", "Uma"];

// ---------------------------------------------------------------- the crowd

export class Crowd {
  private personas = new Map<Phone, Persona>();
  private bank: Bank;
  private rand = seeded(7);
  private timers = new Set<NodeJS.Timeout>();
  engine?: Engine;

  constructor(private store: Store) {
    this.bank = loadBank();
    const sizes = Object.entries(this.bank).map(([k, v]) => `${k} ${v.length}`).join(", ");
    console.log(`[crowd] reply bank from the reference conversations: ${sizes || "empty (file missing)"}`);
  }

  isSim(phone: Phone): boolean {
    return phone.startsWith("sim:");
  }

  /** Wrap the real transport: texts to simulated members never leave this laptop; they get answered instead. */
  wrap(real: Transport): Transport {
    return {
      send: async (phone, text) => {
        if (!this.isSim(phone)) return real.send(phone, text);
        this.answerLater(phone);
      },
      lineFor: real.lineFor?.bind(real),
      prepare: real.prepare?.bind(real),
    };
  }

  /** Add n labeled simulated members to the current trip, with seeded personas. Returns their ids. */
  personaFor(phone: Phone): Persona {
    let p = this.personas.get(phone);
    if (!p) {
      p = makePersona(this.rand);
      this.personas.set(phone, p);
    }
    return p;
  }

  nextNames(n: number, taken: Set<string>): string[] {
    return NAMES.filter((x) => !taken.has(x)).slice(0, n);
  }

  private answerLater(phone: Phone): void {
    // The question we just asked is the member's pendingAsk (set before sending).
    const tripId = this.store.state.phoneTrip[phone];
    const m = tripId ? this.store.state.trips[tripId]?.members[phone] : undefined;
    const topic = m?.pendingAsk?.topic;
    if (!m || !topic) return; // an ack or a note: nothing to answer
    const persona = this.personaFor(phone);
    if (persona.slow) return;
    const text = replyFor(persona, topic, this.bank, this.rand);
    if (!text) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.engine?.handleInbound(phone, text);
    }, persona.replyDelayMs);
    this.timers.add(t);
  }

  reset(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.personas.clear();
    this.rand = seeded(7);
  }
}
