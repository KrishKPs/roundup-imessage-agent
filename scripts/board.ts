// Offline switchboard: the dashboard + crowd mode with no iMessage, no Photon, no internet (Dashboard.md check 8).
// Its own state file, so it never touches the real trips. Real texts are printed here instead of sent.
// Usage: npm run board   then open http://localhost:3011 and use the demo bar (S, C, G, D, R).
import { startDashboard } from "../src/dashboard/server.js";
import { vidOf } from "../src/dashboard/view.js";
import { Engine } from "../src/engine/engine.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Crowd } from "../src/sim/crowd.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";

const PORT = Number(process.env.BOARD_PORT || 3011);
const store = new Store("data/board-preview.json");
const printer = new FakeTransport();
printer.onSend = (m) => console.log(`-> ${m.phone.slice(0, 6)}… ${m.text}`);
const crowd = new Crowd(store);
let dashboard: ReturnType<typeof startDashboard> | null = null;
const engine: Engine = new Engine({
  store, transport: crowd.wrap(printer), understand: makeUnderstander(null), phrase: makePhraser(null),
  cfg: { nudgeAfterMs: 20_000, giveUpAfterMs: 40_000, demoMode: true, demoChainTarget: "real" },
  onChange: () => dashboard?.broadcast(),
  onPulse: (phone, direction, topic) => {
    const t = store.state.phoneTrip[phone] ? store.state.trips[store.state.phoneTrip[phone]] : undefined;
    const m = t?.members[phone];
    if (m) dashboard?.pulse({ memberId: vidOf(m), direction, topic, at: Date.now() });
  },
});
crowd.engine = engine;
dashboard = startDashboard({
  port: PORT, getState: () => store.state, demoMode: true,
  onDemo: async (action) => {
    if (action === "ping") return "ok";
    if (action === "reset") { crowd.reset(); return engine.reset(); }
    if (action === "seed") {
      crowd.reset();
      return engine.seedDemo({ organizerPhone: "sim:organizer", organizerName: "Priya", memberPhone: "sim:mate", memberName: "Sam" });
    }
    if (action === "crowd") {
      const trip = Object.values(store.state.trips).sort((a, b) => b.createdAt - a.createdAt)[0];
      const names = crowd.nextNames(12, new Set(Object.values(trip?.members ?? {}).map((m) => m.name)));
      return engine.addCrowd(names, (p) => crowd.personaFor(p).canDrive);
    }
    if (action === "start") return engine.demoStart();
    if (action === "drop") return engine.demoDrop();
    throw new Error(`unknown action ${action}`);
  },
});
setInterval(() => void engine.tick(), 5_000);
console.log(`[board] offline switchboard at http://localhost:${PORT} (crowd mode, no iMessage)`);
