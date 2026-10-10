// Reads and validates environment variables with zod. Exits with a clear message when one is missing.
import "dotenv/config";
import { z } from "zod";

const boolish = z
  .string()
  .optional()
  .transform((v) => (v ?? "true").toLowerCase() === "true");

const schema = z.object({
  SPECTRUM_PROJECT_ID: z.string().min(1, "SPECTRUM_PROJECT_ID is missing. Copy it from the Photon dashboard Settings page into .env."),
  SPECTRUM_PROJECT_SECRET: z.string().min(1, "SPECTRUM_PROJECT_SECRET is missing. Copy it from the Photon dashboard Settings page into .env."),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().optional().default(""),
  PORT: z.coerce.number().int().positive().default(3000),
  NUDGE_AFTER_SECONDS: z.coerce.number().positive().default(120),
  GIVE_UP_AFTER_SECONDS: z.coerce.number().positive().default(240),
  DEMO_MODE: boolish,
  AGENT_NUMBER: z.string().optional().default(""), // the number people text; used for tap-to-join links
  IMESSAGE_MODE: z.enum(["cloud", "local"]).default("cloud"), // local = this Mac's Messages app (can text people first)
  PUBLIC_URL: z.string().optional().default(""), // fixed public address for the website; blank = use the tunnel
  TUNNEL: boolish, // start a free cloudflared tunnel so trip links open on phones
  DEDICATED_LINE: z.string().optional().transform((v) => (v ?? "false").toLowerCase() === "true"),
});

export type Config = z.infer<typeof schema>;

/** Load config. With `requireSpectrum: false` (simulator, seed) the Spectrum keys may be blank. */
export function loadConfig(opts: { requireSpectrum: boolean } = { requireSpectrum: true }): Config {
  const env = { ...process.env };
  if (!opts.requireSpectrum || env.IMESSAGE_MODE === "local") { // local mode needs no Photon keys
    env.SPECTRUM_PROJECT_ID ||= "unused";
    env.SPECTRUM_PROJECT_SECRET ||= "unused";
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    console.error("\nConfig error in .env:");
    for (const issue of parsed.error.issues) console.error(`  - ${issue.message}`);
    console.error("See .env.example for the full list.\n");
    process.exit(1);
  }
  const cfg = parsed.data;
  if (!cfg.GEMINI_API_KEY || !cfg.GEMINI_MODEL) {
    console.warn("[config] GEMINI_API_KEY or GEMINI_MODEL not set. Using keyword parsing and fixed templates only.");
  }
  return cfg;
}
