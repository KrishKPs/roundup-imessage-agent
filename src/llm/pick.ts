// Picks the language model from .env: Claude if ANTHROPIC_API_KEY is set, else Gemini, else none (keywords + templates).
import type { Config } from "../config.js";
import { makeClaude } from "./claude.js";
import { type Llm, makeGemini } from "./gemini.js";

export function pickLlm(cfg: Config, timeoutMs: number): Llm | null {
  if (cfg.ANTHROPIC_API_KEY) return makeClaude(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL, timeoutMs);
  return makeGemini(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, timeoutMs);
}

export function llmName(cfg: Config): string {
  if (cfg.ANTHROPIC_API_KEY) return `Claude (${cfg.ANTHROPIC_MODEL})`;
  if (cfg.GEMINI_API_KEY && cfg.GEMINI_MODEL) return `Gemini (${cfg.GEMINI_MODEL})`;
  return "none";
}
