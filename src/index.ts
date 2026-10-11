// Entry point: load config and state, connect to iMessage through Spectrum, start the engine,
// the silence timer, and the trip board.
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { vidOf } from "./dashboard/view.js";
import { Crowd } from "./sim/crowd.js";
import { Engine } from "./engine/engine.js";
import { llmName, pickLlm } from "./llm/pick.js";
import { makePhraser } from "./llm/phrase.js";
import { makeUnderstander } from "./llm/understand.js";
import { makeTripExtractor } from "./llm/tripRequest.js";
import { makeConverser } from "./llm/converse.js";
import { makeItineraryWriter } from "./llm/itinerary.js";
import { Store } from "./store.js";
import type { Transport } from "./transport/transport.js";
import { startTunnel } from "./tunnel.js";

const cfg = loadConfig();
const store = new Store("data/state.json");
const understandLlm = pickLlm(cfg, 5000);
const phraseLlm = pickLlm(cfg, 2500); // shorter: replies must land in < 4 s
console.log(`[llm] model: ${llmName(cfg)}`);

// cloud = Photon's managed lines; local = this Mac's Messages app (can text people first). Both are Spectrum.
const local = cfg.IMESSAGE_MODE === "local";
console.log(`[spectrum] connecting (${local ? "local Messages app on this Mac" : "Photon cloud"})...`);
const realTransport = local
  ? await (await import("./transport/local.js")).LocalTransport.connect()
  : await (await import("./transport/spectrum.js")).SpectrumTransport.connect(cfg.SPECTRUM_PROJECT_ID, cfg.SPECTRUM_PROJECT_SECRET);
console.log("[spectrum] connected. Text the agent's number to begin.");
// Crowd mode: texts to simulated members ("sim:N") never leave this laptop (Dashboard.md 10).
const crowd = new Crowd(store);
const transport = crowd.wrap(realTransport);
// (engine is created below; the crowd feeds simulated replies into it)

let dashboard: ReturnType<typeof startDashboard> | null = null;
const engine: Engine = new Engine({
  store,
  transport,
  understand: makeUnderstander(understandLlm),
  phrase: makePhraser(phraseLlm),
  cfg: {
    nudgeAfterMs: cfg.NUDGE_AFTER_SECONDS * 1000,
    giveUpAfterMs: cfg.GIVE_UP_AFTER_SECONDS * 1000,
    demoMode: cfg.DEMO_MODE,
    agentNumber: cfg.AGENT_NUMBER,
    dedicatedLine: cfg.DEDICATED_LINE,
    quietToStrangers: local,
    demoChainTarget: process.env.DEMO_CHAIN_TARGET === "real" ? "real" : undefined,
    tripLink: (code) => {
      const base = cfg.PUBLIC_URL.replace(/\/$/, "") || tunnel?.url;
      return base ? `${base}/t/${code}` : null;
    },
  },
  onChange: () => dashboard?.broadcast(),
  onPulse: (phone, direction, topic) => {
    const trip = store.state.phoneTrip[phone] ? store.state.trips[store.state.phoneTrip[phone]] : undefined;
    const m = trip?.members[phone];
    if (m) dashboard?.pulse({ memberId: vidOf(m), direction, topic, at: Date.now() });
  },
  extractTrip: makeTripExtractor(understandLlm),
  converse: makeConverser(pickLlm(cfg, 10000)), // the reply they're waiting for: worth a few more seconds than a canned answer
  writeItinerary: makeItineraryWriter(pickLlm(cfg, 20000)), // a whole day plan: the organizer will wait a bit longer for this
});
crowd.engine = engine;

const tunnel = cfg.TUNNEL && !cfg.PUBLIC_URL ? startTunnel(cfg.PORT) : null;

dashboard = startDashboard({
  port: cfg.PORT,
  getState: () => store.state,
  demoMode: cfg.DEMO_MODE,
  agentNumber: cfg.DEDICATED_LINE ? cfg.AGENT_NUMBER : undefined, // QR only works with one shared number
  onSeed: async (body) => {
    const organizerPhone = body.organizerPhone || process.env.SEED_ORGANIZER_PHONE;
    const memberPhone = body.memberPhone || process.env.SEED_MEMBER_PHONE;
    if (!organizerPhone || !memberPhone) throw new Error("Set SEED_ORGANIZER_PHONE and SEED_MEMBER_PHONE in .env");
    await engine.seedDemo({
      organizerPhone,
      organizerName: body.organizerName || process.env.SEED_ORGANIZER_NAME || "Priya",
      memberPhone,
      memberName: body.memberName || process.env.SEED_MEMBER_NAME || "Sam",
    });
  },
  onReset: async () => {
    crowd.reset();
    await engine.reset();
  },
  // Demo bar (Dashboard.md 11). Seed works without phones: missing teammates become labeled simulated members.
  onDemo: async (action) => {
    if (action === "ping") return "ok";
    if (action === "reset") {
      crowd.reset();
      return engine.reset();
    }
    if (action === "seed") {
      crowd.reset();
      await engine.seedDemo({
        organizerPhone: process.env.SEED_ORGANIZER_PHONE || "sim:organizer",
        organizerName: process.env.SEED_ORGANIZER_NAME || "Priya",
        memberPhone: process.env.SEED_MEMBER_PHONE || "sim:mate",
        memberName: process.env.SEED_MEMBER_NAME || "Sam",
      });
      return "seeded";
    }
    if (action === "crowd") {
      const trip = Object.values(store.state.trips).sort((a, b) => b.createdAt - a.createdAt)[0];
      const taken = new Set(Object.values(trip?.members ?? {}).map((m) => m.name));
      const names = crowd.nextNames(12, taken);
      await engine.addCrowd(names, (phone) => crowd.personaFor(phone).canDrive);
      return `${names.length} simulated members added`;
    }
    if (action === "start") return engine.demoStart();
    if (action === "drop") return engine.demoDrop();
    throw new Error(`unknown demo action ${action}`);
  },
  web: {
    createTrip: (input) => engine.createTripFromWeb(input),
    join: (code, person) => engine.joinFromWeb(code, person),
    prepare: async (phone) => (await (transport as Transport).prepare?.(phone)) || cfg.AGENT_NUMBER || undefined,
    publicUrl: () => cfg.PUBLIC_URL.replace(/\/$/, "") || tunnel?.url,
  },
});

const timer = setInterval(() => void engine.tick(), 15_000);

async function shutdown() {
  console.log("\nshutting down...");
  clearInterval(timer);
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 8000))]); // finish the reply in progress
  dashboard?.server.close();
  tunnel?.stop();
  crowd.reset();
  await realTransport.stop().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await realTransport.listen(
  (phone, text) => engine.handleInbound(phone, text),
  (phone, people) => engine.handleContacts(phone, people),
);
