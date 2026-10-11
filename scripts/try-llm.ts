// Runs a handful of real-world texts through Gemini (no phones, no Photon) so we can read and tune the replies.
// Usage: npm run try-llm   (needs ANTHROPIC_API_KEY, or GEMINI_API_KEY + GEMINI_MODEL, in .env)
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine/engine.js";
import { makeConverser } from "../src/llm/converse.js";
import { makeItineraryWriter } from "../src/llm/itinerary.js";
import { llmName, pickLlm } from "../src/llm/pick.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";

const cfg = loadConfig({ requireSpectrum: false });
const llm = pickLlm(cfg, 5000);
if (!llm) {
  console.error("Set ANTHROPIC_API_KEY (or GEMINI_API_KEY + GEMINI_MODEL) in .env first.");
  process.exit(1);
}
console.log(`model: ${llmName(cfg)}`);
const transport = new FakeTransport();
const names: Record<string, string> = { "+19195550100": "Krish", "+19195550101": "Sam", "+19195550102": "Maya" };
transport.onSend = (m) => console.log(`   -> ${names[m.phone]}: ${m.text}`);
const engine = new Engine({
  store: new Store(null), transport, understand: makeUnderstander(llm), phrase: makePhraser(llm),
  cfg: { nudgeAfterMs: 120_000, giveUpAfterMs: 240_000, demoMode: true, tripLink: (c) => `https://example.trycloudflare.com/t/${c}` },
  converse: makeConverser(llm), writeItinerary: makeItineraryWriter(pickLlm(cfg, 20000)),
});
const [krish, sam, maya] = Object.keys(names);
const say = async (p: string, text: string) => {
  console.log(`\n<- ${names[p]}: ${text}`);
  const t = Date.now();
  await engine.handleInbound(p, text);
  console.log(`   (${Date.now() - t} ms)`);
};

const code = await engine.createTripFromWeb({ title: "Camping trip", dateText: "sunday", name: "Krish", phone: krish });
await engine.joinFromWeb(code, { name: "Sam", phone: sam });
await engine.joinFromWeb(code, { name: "Maya", phone: maya });
await say(krish, "hi Roundup! i'm Krish, planning Camping trip");
await say(sam, `hi! i'm Sam, joining Camping trip (${code})`);
await say(maya, `hi! i'm Maya, joining Camping trip (${code})`);
await say(sam, "yo what is this exactly");
await say(krish, "does 10am saturday work for everyone?");
await say(sam, "ya works for me");
await say(maya, "hmm i have class till 11 so not really");
await say(krish, "ask everyone what days between saturday and tuesday they are free and what times work");
await say(sam, "sat after 2 or sunday all day");
await say(maya, "sunday works, monday evening too");
await say(krish, "alright so what time works for everyone");
await say(krish, "ok lets move it to sunday 11am");
await say(krish, "we need someone to bring a tent and a speaker");
await say(krish, "alright everyone's in, kick it off");
await say(sam, "im in!! but im kinda broke lol");
await say(sam, "like 40 bucks max");
await say(maya, "do we need to bring our own food?");
await say(maya, "yeah i'm in");
await say(krish, "how's it looking?");
await say(maya, "fyi im allergic to peanuts");
await say(krish, "we're going to Jordan Lake");
await say(krish, "make the itinerary");
await say(krish, "push everything an hour later and add a bonfire at sunset");
await say(krish, "perfect send it");
