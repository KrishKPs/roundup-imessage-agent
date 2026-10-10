// Entry point: load config and state, connect to iMessage through Spectrum, start the engine,
// the silence timer, and the trip board.
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { Engine } from "./engine/engine.js";
import { makeGemini } from "./llm/gemini.js";
import { makePhraser } from "./llm/phrase.js";
import { makeUnderstander } from "./llm/understand.js";
import { makeTripExtractor } from "./llm/tripRequest.js";
import { Store } from "./store.js";
import { SpectrumTransport } from "./transport/spectrum.js";

const cfg = loadConfig();
const store = new Store("data/state.json");
const understandLlm = makeGemini(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, 5000);
const phraseLlm = makeGemini(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, 2500); // shorter: replies must land in < 4 s

console.log("[spectrum] connecting...");
const transport = await SpectrumTransport.connect(cfg.SPECTRUM_PROJECT_ID, cfg.SPECTRUM_PROJECT_SECRET);
console.log("[spectrum] connected. Text the agent's number to begin.");

let dashboard: ReturnType<typeof startDashboard> | null = null;
const engine = new Engine({
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
  },
  onChange: () => dashboard?.broadcast(),
  extractTrip: makeTripExtractor(understandLlm),
});

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
  onReset: () => engine.reset(),
});

const timer = setInterval(() => void engine.tick(), 15_000);

async function shutdown() {
  console.log("\nshutting down...");
  clearInterval(timer);
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 8000))]); // finish the reply in progress
  dashboard?.server.close();
  await transport.stop().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await transport.listen(
  (phone, text) => engine.handleInbound(phone, text),
  (phone, people) => engine.handleContacts(phone, people),
);
