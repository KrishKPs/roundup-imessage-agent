// Claude (Anthropic API) behind the same tiny Llm interface as Gemini, with a hard timeout.
// Returns null when no key is configured, so the bot falls back to Gemini or to keywords + templates.
import Anthropic from "@anthropic-ai/sdk";
import type { Llm } from "./gemini.js";

export function makeClaude(apiKey: string, model: string, timeoutMs = 5000): Llm | null {
  if (!apiKey || !model) return null;
  const client = new Anthropic({ apiKey, maxRetries: 0 }); // a retry would blow the reply-time budget; templates take over instead
  return {
    async generate(prompt, opts = {}) {
      const res = await client.beta.messages.create(
        {
          model,
          max_tokens: 1024,
          // Short texts and tiny JSON: low effort keeps replies fast.
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default", // if a safety classifier declines, the API retries on a fallback model in the same call
          system: opts.json
            ? "Reply with a single JSON object only. No prose, no code fences."
            : "Reply with only the text message itself.",
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: timeoutMs },
      );
      if (res.stop_reason === "refusal") throw new Error("declined");
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      if (!text) throw new Error("empty response");
      return text;
    },
  };
}
