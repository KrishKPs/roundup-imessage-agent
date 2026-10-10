// Runs a scripted 6-person trip through the fake transport and prints every message.
// No credentials or phones needed: `npm run simulate`.
// `npm run simulate -- --board` also serves the trip board on PORT and slows down so you can watch it.
import { Engine } from "../src/engine/engine.js";
import { makePhraser } from "../src/llm/phrase.js";
import { makeUnderstander } from "../src/llm/understand.js";
import { Store } from "../src/store.js";
import { FakeTransport } from "../src/transport/fake.js";
import { startDashboard } from "../src/dashboard/server.js";

const board = process.argv.includes("--board");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const people = {
  Priya: "+19195550001",
  Sam: "+19195550002",
  Maya: "+19195550003",
  Leo: "+19195550004",
  Jo: "+19195550005",
  Ana: "+19195550006",
};
const nameOf = Object.fromEntries(Object.entries(people).map(([n, p]) => [p, n]));

let clock = 1_000_000;
const transport = new FakeTransport();
transport.onSend = (m) => console.log(`  -> ${nameOf[m.phone] ?? m.phone}: ${m.text}`);
const store = new Store(null);
let dash: ReturnType<typeof startDashboard> | null = null;
const engine = new Engine({
  store,
  transport,
  understand: makeUnderstander(null),
  phrase: makePhraser(null),
  cfg: { nudgeAfterMs: 120_000, giveUpAfterMs: 240_000, demoMode: true },
  now: () => clock,
  onChange: () => dash?.broadcast(),
});
if (board) dash = startDashboard({ port: Number(process.env.PORT || 3000), getState: () => store.state, demoMode: false });

async function say(name: keyof typeof people, text: string) {
  console.log(`<- ${name}: ${text}`);
  clock += 1000;
  if (board) await sleep(1200);
  await engine.handleInbound(people[name], text);
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  section("organizer creates the trip");
  await say("Priya", "new trip Beach day on Saturday");
  await say("Priya", "Priya");
  await say("Priya", "need cooler, speaker");
  const code = Object.values(engine.state.trips)[0].code;

  section("friends join with the code");
  await say("Sam", `join ${code}`);
  await say("Sam", "sam");
  await say("Maya", `join ${code} Maya`);
  await say("Leo", `join ${code} Leo`);
  await say("Jo", `join ${code} Jo`);
  await say("Ana", `join ${code} Ana`);

  section("start: everyone gets asked privately, in parallel");
  await say("Priya", "start");
  await say("Priya", "60");
  await say("Sam", "yes!");
  await say("Sam", "40");
  await say("Maya", "yeah i'm in, i have a car");
  await say("Maya", "$85");
  await say("Leo", "maybe");
  await say("Leo", "skip");
  await say("Jo", "yep");
  await say("Jo", "100");

  section("Ana goes quiet; time passes");
  clock += 125_000;
  await engine.tick();
  clock += 125_000;
  await engine.tick();

  section("seats chain: Priya, then Maya (mentioned a car)");
  await say("Priya", "no sorry, my car's in the shop");
  await say("Maya", "yeah, 5 seats");

  section("item chains: cooler (organizer first, then non-drivers), then speaker");
  await say("Priya", "nah");
  await say("Sam", "hmm what");
  await say("Sam", "sure");
  await say("Priya", "yes i have one");

  section("a question");
  await say("Jo", "what time are we leaving?");

  section("Ana answers late: still applied");
  await say("Ana", "yes sorry just saw this");
  await say("Ana", "50");

  section("driver drops out after the plan is sent");
  await say("Maya", "ugh i can't come anymore, so sorry");
  await say("Sam", "yeah 4 seats");
  await say("Jo", "nope");

  section("stop");
  await say("Leo", "stop");
  await say("Leo", "hello?");

  section("organizer status");
  await say("Priya", "status");

  section("dashboard feed");
  for (const e of Object.values(engine.state.trips)[0].log.slice(-12)) console.log(`  [${e.kind}] ${e.text}`);
  if (board) console.log("\nboard still running at http://localhost:" + (process.env.PORT || 3000) + " (Ctrl+C to quit)");
  else process.exit(0);
}

main();
