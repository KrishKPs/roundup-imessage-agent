// The trip board: serves one HTML page, a JSON snapshot, and a Server-Sent Events stream.
// Only the dashboard-safe view is ever sent (no budgets, masked phones).
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { currentTrip, toDashboardView } from "./view.js";
import { tripPage } from "../engine/itinerary.js";
import type { State, Trip } from "../types.js";
import { joinLink, normalizePhone, smsLink } from "../util.js";

export interface DashboardOptions {
  port: number;
  getState: () => State;
  demoMode: boolean;
  agentNumber?: string;
  onSeed?: (body: Record<string, string>) => Promise<void>;
  onReset?: () => Promise<void>;
  onDemo?: (action: string, body: Record<string, unknown>) => Promise<unknown>;
  /** Website "+" and trip links. */
  web?: {
    createTrip: (input: { title: string; dateText: string | null; name: string; phone: string }) => Promise<string>;
    join: (code: string, person: { name: string; phone: string }) => Promise<string | null>;
    /** Register the number with Photon; returns the bot number they should text. */
    prepare: (phone: string) => Promise<string | undefined>;
    /** Public https address (tunnel), so links work on phones. */
    publicUrl: () => string | undefined;
  };
}

/** Requests that came in through the public tunnel (cloudflared adds this header). */
const viaTunnel = (req: Request) => !!req.get("cf-connecting-ip");

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A real-looking phone number, normalized to E.164, or null. */
function webPhone(v: unknown): string | null {
  const raw = clean(v, 30);
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return normalizePhone(raw);
}


export function startDashboard(opts: DashboardOptions) {
  const app = express();
  app.use(express.json());
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, "public")));

  const baseUrl = (req?: Request) => {
    const pub = opts.web?.publicUrl();
    if (pub) return pub;
    if (!req) return null;
    return `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
  };

  /** The switchboard snapshot (Dashboard.md 4.1). The join QR opens the trip link page (works on the shared pool). */
  const snapshot = () => {
    const trip = currentTrip(opts.getState());
    const base = baseUrl();
    const link = trip ? (base && opts.web ? `${base}/j/${trip.code}` : opts.agentNumber ? joinLink(opts.agentNumber, trip.code) : null) : null;
    return toDashboardView(trip, { joinLink: link });
  };

  // ---- website: create a trip, and the trip link members open
  app.get("/new", (_req, res) => {
    res.sendFile(path.join(here, "public", "new.html"));
  });

  // The trip page anyone in the group can open: the sent itinerary, rides, what to bring. Names only.
  app.get("/t/:code", (_req, res) => {
    res.sendFile(path.join(here, "public", "trip.html"));
  });
  app.get("/api/t/:code", (req, res) => {
    const trip = Object.values(opts.getState().trips).find((t) => t.code === req.params.code.toUpperCase());
    if (!trip) return res.status(404).json({ error: "This trip link doesn't work anymore." });
    res.json(tripPage(trip));
  });

  app.get("/j/:code", (_req, res) => {
    res.sendFile(path.join(here, "public", "join.html"));
  });

  app.get("/api/trips/:code", (req, res) => {
    const trip = Object.values(opts.getState().trips).find((t) => t.code === req.params.code.toUpperCase());
    if (!trip) return res.status(404).json({ error: "That trip link doesn't work anymore. Ask your organizer for a new one." });
    res.json({ title: trip.title, dateText: trip.dateText, organizer: trip.members[trip.organizer]?.name || "your friend" });
  });

  app.post("/api/trips", async (req, res) => {
    if (!opts.web) return res.status(404).json({ error: "This is the offline preview, so it can't create real trips. Start the real bot with npm run dev and use its link." });
    const title = clean(req.body?.title, 60);
    const name = clean(req.body?.name, 30);
    const phone = webPhone(req.body?.phone);
    if (!title || !name || !phone) return res.status(400).json({ error: "Fill in the trip name, your name, and your phone number." });
    try {
      const code = await opts.web.createTrip({ title, dateText: clean(req.body?.date, 40) || null, name, phone });
      const line = await opts.web.prepare(phone);
      if (!line) return res.status(502).json({ error: "Couldn't set up your number with iMessage. Try again in a moment." });
      res.json({
        code,
        joinUrl: `${baseUrl(req)}/j/${code}`,
        smsLink: smsLink(line, `hi Roundup! i'm ${name}, planning ${title}`),
      });
    } catch (err) {
      console.error("[web] create failed:", err);
      res.status(500).json({ error: "Something went wrong. Try again." });
    }
  });

  app.post("/api/trips/:code/join", async (req, res) => {
    if (!opts.web) return res.status(404).json({ error: "This is the offline preview, so it can't add real people. Use the real bot's link." });
    const code = clean(req.params.code, 10).toUpperCase();
    const name = clean(req.body?.name, 30);
    const phone = webPhone(req.body?.phone);
    if (!name || !phone) return res.status(400).json({ error: "Add your first name and phone number." });
    try {
      const title = await opts.web.join(code, { name, phone });
      if (!title) return res.status(404).json({ error: "Couldn't join this trip. Ask your organizer for a new link." });
      const line = await opts.web.prepare(phone);
      if (!line) return res.status(502).json({ error: "Couldn't set up your number with iMessage. Try again in a moment." });
      res.json({ title, smsLink: smsLink(line, `hi! i'm ${name}, joining ${title} (${code})`) });
    } catch (err) {
      console.error("[web] join failed:", err);
      res.status(500).json({ error: "Something went wrong. Try again." });
    }
  });

  app.get("/api/state", (_req, res) => {
    res.json(snapshot());
  });

  const clients = new Set<Response>();
  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  // Demo-only controls, used by `npm run seed` between judges. Local machine only.
  app.post("/api/seed", async (req, res) => {
    if (viaTunnel(req)) return res.status(403).json({ error: "local only" });
    if (!opts.demoMode || !opts.onSeed) return res.status(403).json({ error: "DEMO_MODE is off" });
    try {
      await opts.onSeed(req.body ?? {});
      res.json({ ok: true, trip: snapshot() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.post("/api/reset", async (req, res) => {
    if (viaTunnel(req)) return res.status(403).json({ error: "local only" });
    if (!opts.demoMode || !opts.onReset) return res.status(403).json({ error: "DEMO_MODE is off" });
    await opts.onReset();
    res.json({ ok: true });
  });

  // Demo bar (Dashboard.md 11): this laptop only, DEMO_MODE only.
  app.post("/api/demo/:action", async (req, res) => {
    if (!opts.demoMode || viaTunnel(req) || !opts.onDemo) return res.status(404).end();
    try {
      res.json({ ok: true, result: await opts.onDemo(req.params.action, req.body ?? {}) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  const server = app.listen(opts.port, "127.0.0.1", () => {
    console.log(`[dashboard] trip board at http://localhost:${opts.port}`);
  });

  return {
    server,
    /** Push the latest view to every open board. */
    broadcast() {
      const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      for (const c of clients) c.write(data);
    },
    /** One dot of animation: a private text went out to / came in from this member. No content. */
    pulse(p: { memberId: string; direction: "in" | "out"; topic: string | null; at: number }) {
      const data = `event: pulse\ndata: ${JSON.stringify(p)}\n\n`;
      for (const c of clients) c.write(data);
    },
  };
}
