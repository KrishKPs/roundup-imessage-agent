// Thin wrapper around the Gemini API with a hard timeout. Returns null when no key is configured.
import { GoogleGenAI } from "@google/genai";

export interface Llm {
  generate(prompt: string, opts?: { json?: boolean }): Promise<string>;
}

export function makeGemini(apiKey: string, model: string, timeoutMs = 5000): Llm | null {
  if (!apiKey || !model) return null;
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generate(prompt, opts = {}) {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: opts.json ? 0 : 0.7,
          maxOutputTokens: 200,
          responseMimeType: opts.json ? "application/json" : "text/plain",
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });
      const text = res.text;
      if (!text) throw new Error("empty response");
      return text;
    },
  };
}
