// The trip board: serves one HTML page, a JSON snapshot, and a Server-Sent Events stream.
// Only the dashboard-safe view is ever sent (no budgets, masked phones).
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Response } from "express";
import { publicView } from "../engine/view.js";
import type { State, Trip } from "../types.js";
import { joinLink } from "../util.js";

export interface DashboardOptions {
  port: number;
  getState: () => State;
  demoMode: boolean;
  agentNumber?: string;
  onSeed?: (body: Record<string, string>) => Promise<void>;
  onReset?: () => Promise<void>;
}

export function currentTrip(state: State): Trip | undefined {
  return Object.values(state.trips).sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function startDashboard(opts: DashboardOptions) {
  const app = express();
  app.use(express.json());
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, "public")));

  const snapshot = () => {
    const trip = currentTrip(opts.getState());
    return trip ? { ...publicView(trip), joinLink: opts.agentNumber ? joinLink(opts.agentNumber, trip.code) : null } : null;
  };

  app.get("/api/state", (_req, res) => {
    res.json(snapshot());
  });

  const clients = new Set<Response>();
  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  // Demo-only controls, used by `npm run seed` between judges. Local machine only.
  app.post("/api/seed", async (req, res) => {
    if (!opts.demoMode || !opts.onSeed) return res.status(403).json({ error: "DEMO_MODE is off" });
    try {
      await opts.onSeed(req.body ?? {});
      res.json({ ok: true, trip: snapshot() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.post("/api/reset", async (_req, res) => {
    if (!opts.demoMode || !opts.onReset) return res.status(403).json({ error: "DEMO_MODE is off" });
    await opts.onReset();
    res.json({ ok: true });
  });

  const server = app.listen(opts.port, "127.0.0.1", () => {
    console.log(`[dashboard] trip board at http://localhost:${opts.port}`);
  });

  return {
    server,
    /** Push the latest view to every open board. */
    broadcast() {
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const c of clients) c.write(data);
    },
  };
}
