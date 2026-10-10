# CLAUDE.md — Roundup (HackNC 2026, Photon track)

You are building **Roundup**, an AI agent that lives in iMessage and plans a group trip by
texting every member **individually**, so 15-20 people never have to coordinate in one
chaotic group chat. This file is the full spec. Read all of it before writing code.

"Roundup" is a working name. If the team renames the project, rename the repo and update
this file.

---

## 0. FIRST TASK — create the GitHub repo (do this before anything else)

Do not write any project code until the repo exists and the first commit is pushed.

1. Confirm tools: run `git --version`, `node --version` (need Node 20 or newer), and
   `gh auth status`.
2. If `gh` is not installed or not logged in, stop and tell the user exactly what to do
   (`gh auth login`, choose GitHub.com, HTTPS, login with browser). If they cannot install
   `gh`, ask them to create an empty **public** repo named `roundup-imessage-agent` on
   github.com and paste the URL, then use `git remote add origin <url>`.
3. In the project folder:
   ```bash
   git init -b main
   ```
4. Create these files before the first commit:
   - `.gitignore` containing at least: `node_modules/`, `.env`, `.env.*`, `!.env.example`,
     `data/`, `dist/`, `.DS_Store`
   - `.env.example` (see section 6; keys only, no values)
   - `README.md` with the one-line pitch (expand it in Milestone 7)
   - this `CLAUDE.md`
5. First commit and push:
   ```bash
   git add .
   git commit -m "chore: initial scaffold"
   gh repo create roundup-imessage-agent --public --source=. --remote=origin --push
   ```
6. Print the repo URL for the user. They need it for the Devpost submission.

Repo rules for the whole build:
- The repo must be **public**. The hackathon requires a GitHub link to all code.
- **Never commit secrets.** `.env` stays ignored. Before every commit, run `git status`
  and check that no key or token is staged.
- Commit after every milestone and after every working sub-step, with clear messages
  (`feat:`, `fix:`, `chore:`, `docs:`). Push after every commit. A laptop dying at 4 AM
  must not lose work.
- All code must be written during the hackathon. Do not copy in old project code.

---

## 1. Hard constraints (do not violate)

| Constraint | Detail |
|---|---|
| Submission deadline | **Sunday Oct 11, 2026, 10:00 AM Eastern**, on Devpost. No extensions. |
| Mandatory deliverables | Public GitHub link + demo video of **2 minutes or less**. No video means not judged. |
| One project per team | Only one submission is allowed. |
| Photon requirement | The project **must integrate Spectrum** (`spectrum-ts`). No Spectrum means not eligible. |
| Judging format | Demo fair 12:00-1:30 PM. Each judge gets 4 minutes at our table: 2 minutes demo, 2 minutes questions. Judges come one at a time. |
| Hardware | No hardware hacks. Software only. |

Time is the scarcest resource. When a choice is between "more features" and "the core
flow never breaks", always choose the second.

---

## 2. What we are building

### The problem
Planning a trip with 15-20 people in one group chat fails: messages get buried, the same
question is asked five times, people hide their real budget, and one person does all the
organizing.

### The product
An AI agent with a real phone number. The organizer texts it to start a trip. Every member
texts it once to join. From then on the agent runs private one-on-one conversations with
each member, collects what they need and what they can contribute, fills every gap by
asking the next best person, and sends each person a plan made for them.

### The signature behavior ("chained asking")
The agent asks member A, "can you drive?" If A says no, the agent asks member B. It keeps
going until enough seats exist, then **stops asking**. Nobody else is bothered. The same
mechanism fills every other need (cooler, speaker, tent).

### One-line pitch
"An AI that plans your group trip by texting everyone individually, so the group chat
doesn't have to."

### How Photon judges, and what in this build answers each criterion

| Criterion | Their question | What we must show |
|---|---|---|
| Vision | Does it push hybrid intelligence? | The agent mediates between humans. It is a group member, not a chatbot serving one person. |
| Craft | Cohesive, responsive, tasteful? | Short casual texts, typing indicator before replies, one question at a time, no nagging. |
| Depth | Real-world context and edge cases? | "maybe" answers, silence, changed answers, a driver dropping out, unclear replies. |
| Traction | Could real users run it tomorrow? | Nothing to download, join by texting a code, works for any friend group. |

Photon's guidelines also describe great projects as having: real human-in-the-loop
collaboration, context that persists across people and time, an agent that helps without
demanding attention, and safety and fallback behaviors that earn trust. Sections 8 and 9
exist to hit those four points. Do not cut them.

---

## 3. Platform facts about Spectrum (verified from Photon's docs on Oct 10, 2026)

Use these as written. Anything marked UNVERIFIED must be checked in the docs before use.

**Docs to read first**
- Docs index for AI tools: https://photon.codes/docs/llms.txt (points to the Stable index
  at https://photon.codes/docs/agents/stable.md). Use **Stable** docs only.
- Quickstart: https://photon.codes/docs/spectrum-ts/getting-started
- iMessage provider: https://photon.codes/docs/spectrum-ts/providers/imessage
- Connection and routing: https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing
- Messaging features (reactions, effects, polls): https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features
- Photon publishes a Spectrum skill for AI coding tools at
  https://www.skills.sh/photon-hq/skills/spectrum. If it can be installed in this
  environment, install it.

**Install and credentials**
- `npm install spectrum-ts` (TypeScript 5+).
- The team signs up at https://app.photon.codes/dashboard with promo code
  `HACKWITHPHOTON` (free Pro plan), creates a project, and connects iMessage in the
  dashboard.
- Credentials are in the project's Settings page. Spectrum reads `SPECTRUM_PROJECT_ID`
  and `SPECTRUM_PROJECT_SECRET` from the environment automatically.

**Receiving and replying (verified shape)**
```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const text = message.content.text;
  const senderId = message.sender?.id;
  await space.responding(async () => {   // shows the typing indicator
    await space.send("hello");
  });
}
```
Also verified: `message.reply(...)`, `message.platform`, `app.stop()` for graceful
shutdown, `options: { logLevel: "debug" }`.

**Starting a conversation with someone (verified shape)**
```ts
const im = imessage(app);
const user = await im.user("+15551111111");   // E.164 phone number
const dm = await im.space.create(user);
await dm.send("hey!");
```
`imessage(space).type` is `"dm"` or `"group"`. `imessage(message).sender?.address` is the
sender's phone number or email when available.

**Limits that shape the design (verified)**
- The free and Pro plans use a **shared pool** of numbers. On the shared pool:
  **the agent cannot create group chats and receives no group events.** Passing several
  users to `space.create()` throws `UnsupportedError`. Different members may see the agent
  under different numbers.
- Therefore **the MVP is DM-only.** This is fine, because one-on-one coordination is the
  product. Do not build anything that depends on a group chat unless a Photon
  representative at the event confirms a dedicated line for our project (see stretch
  goal S1).
- Quota: 5,000 messages per day, and **50 new conversations started per line per day**.
  A "new conversation" is the first message to someone the line has never messaged.
  To stay well under this, members **text the agent first** to join. The agent then
  replies inside an existing conversation.
- The cloud provider needs a Node.js or Bun runtime (it uses gRPC). Do not target edge
  or worker runtimes.

**UNVERIFIED, check docs before using**
- The exact call for tapback reactions (the marketing site shows `message.react("like")`,
  but that snippet is illustrative).
- Whether `message.sender.id` is the phone number. On the first real inbound message,
  log `message.sender` and `imessage(message).sender` and confirm which field holds the
  E.164 number. Key members by that number.
- Polls, effects, and edits. Only use them if the docs confirm the call shape and it
  takes under 20 minutes.

If any verified snippet above fails at runtime, trust the live docs over this file, fix
the code, and update this section.

---

## 4. Tech stack (decided, do not re-debate)

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 20+, ES modules | Spectrum is a TypeScript SDK. |
| Runner | `tsx` for dev (`npm run dev`) | No build step. |
| Messaging | `spectrum-ts`, cloud iMessage provider | Required by the track. |
| LLM | Google Gemini API through the official JS SDK | Also qualifies for the MLH "Best Use of Gemini API" prize. |
| Validation | `zod` | Validate every LLM JSON output. |
| Storage | One JSON file at `data/state.json`, loaded at start, written atomically after every change | Zero setup, survives restarts, nothing native to compile. |
| Dashboard | `express` serving one static HTML page plus a Server-Sent Events endpoint | The "trip board" judges watch on the laptop. |
| Tests | `vitest` on the engine only | The engine must be provably correct before phones are involved. |

For Gemini: check the current official docs for the SDK package name and the current
fast, low-cost model ID. Put the model ID in `GEMINI_MODEL` in `.env`. Never hardcode it.

Do not add: a database server, an ORM, a frontend framework, Docker, auth, or a queue
system. Any of them costs time we do not have.

---

## 5. Architecture

The most important design rule: **the coordination logic is deterministic code. The LLM
only reads and writes text.**

- The LLM never decides whom to ask next, never does arithmetic, and never decides when a
  need is filled. Code does that.
- The LLM has exactly two jobs:
  1. **Understand**: turn a member's free-text reply into a small validated JSON object.
  2. **Phrase**: turn a structured "say this" instruction into one short casual text.
- If the LLM call fails, times out (5 seconds), or returns invalid JSON, fall back to a
  keyword parser for understanding and to a fixed template for phrasing. The demo must
  never stall because an API was slow.

```
iMessage  <->  transport/spectrum.ts  <->  engine (pure logic)  <->  store (JSON file)
                                              |        |
                                         llm/understand  llm/phrase
                                              |
                                        dashboard (SSE)
```

The engine knows nothing about Spectrum. It receives `handleInbound(phone, text)` and
emits outbound messages through a `Transport` interface:

```ts
interface Transport {
  send(phone: string, text: string): Promise<void>;
}
```

There are two implementations: `SpectrumTransport` (real) and `FakeTransport` (records
messages in an array, used by tests and the simulator). This is what lets us test the
whole product at 2 AM without three phones.

### Folder layout
```
src/
  index.ts              # entry: load env, store, engine, transport, dashboard
  config.ts             # reads and validates env with zod
  types.ts              # all shared types (section 7)
  store.ts              # load/save data/state.json atomically
  engine/
    engine.ts           # handleInbound, routing by sender and state
    commands.ts         # organizer and member commands (section 8)
    chain.ts            # the chained-asking algorithm (section 9)
    plan.ts             # seat assignment, budget cap, personalized plan text
    timers.ts           # nudges and timeouts
  llm/
    understand.ts       # reply -> ParsedReply (zod-validated) + keyword fallback
    phrase.ts           # MessageIntent -> text + template fallback
    prompts.ts          # the prompt strings
  transport/
    transport.ts        # the interface
    spectrum.ts         # real iMessage transport
    fake.ts             # in-memory transport
  dashboard/
    server.ts           # express + /events (SSE) + /api/state
    public/index.html   # the trip board, one file, no build step
scripts/
  simulate.ts           # runs a full fake trip in the terminal
test/
  chain.test.ts
  engine.test.ts
  plan.test.ts
data/                   # gitignored
```

---

## 6. Environment variables

`.env.example` (commit this, with empty values):
```
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
GEMINI_API_KEY=
GEMINI_MODEL=
PORT=3000
NUDGE_AFTER_SECONDS=120
GIVE_UP_AFTER_SECONDS=240
DEMO_MODE=true
```
`config.ts` validates these with zod at startup and exits with a clear, human-readable
error naming the missing variable. `DEMO_MODE=true` shortens waits and enables the
`reset` command.

---

## 7. Data model (`src/types.ts`)

```ts
type Phone = string; // E.164, e.g. "+19195550123". Normalize on every inbound.

interface Trip {
  id: string;
  code: string;                 // join code, e.g. "BEACH7" (uppercase, 4-6 chars)
  title: string;                // "Beach day"
  dateText: string | null;      // free text from organizer, e.g. "Saturday"
  organizer: Phone;
  status: "collecting_members" | "coordinating" | "finalized";
  members: Record<Phone, Member>;
  needs: Need[];
  log: LogEvent[];              // feeds the dashboard
  createdAt: number;
}

interface Member {
  phone: Phone;
  name: string;
  rsvp: "unknown" | "yes" | "no" | "maybe";
  budgetCap: number | null;     // PRIVATE. Never sent to anyone else. Never on the dashboard.
  canDrive: boolean | null;
  seats: number | null;         // total seats including the driver
  bringing: string[];           // items this member committed to
  pendingAsk: Ask | null;       // at most ONE open question per member
  askQueue: Ask[];              // questions waiting for the pending one to resolve
  unclearCount: number;         // consecutive replies we could not understand
  optedOut: boolean;
  joinedAt: number;
}

interface Need {
  id: string;
  kind: "seats" | "item";
  label: string;                // "seats" or "cooler"
  quantityNeeded: number;       // seats: number of members going. item: usually 1
  quantityFilled: number;
  candidates: Phone[];          // ordered queue of people still to ask
  asked: Phone[];
  declined: Phone[];
  providers: Phone[];
  status: "open" | "filled" | "short";
}

interface Ask {
  id: string;
  topic: "rsvp" | "budget" | "drive" | "item";
  needId: string | null;
  askedAt: number;
  nudged: boolean;
}

interface LogEvent {
  at: number;
  kind: "joined" | "asked" | "answered" | "need_filled" | "need_short"
      | "dropped" | "nudged" | "handoff" | "finalized";
  text: string;                 // dashboard-safe sentence. NO private data.
}
```

---

## 8. Conversation design

### Voice
- The agent sounds like a helpful friend texting. Lowercase is fine. Friendly, brief.
- **One question per message. Maximum 160 characters per message.**
- Never send more than 2 messages in a row to one person without a reply.
- At most one emoji per message, and most messages have none.
- Use the member's first name occasionally, not in every message.
- First contact always discloses what it is:
  `hey Sam! i'm Roundup, an AI helping Priya plan Beach day. i'll ask you a few quick things here so the group chat stays quiet. reply stop anytime.`

### Commands (matched in code before any LLM call; case-insensitive)

Organizer:
| Text | Effect |
|---|---|
| `new trip <title>` (optionally `on <date>`) | Creates a trip, replies with the join code and a ready-to-forward invite line. |
| `need <item>, <item>` | Adds item needs (cooler, speaker). |
| `start` | Moves to `coordinating` and begins asking members. |
| `status` | Short summary: who's in, seats filled, what is still open. |
| `plan` | Forces finalize with what is known. |
| `reset` | DEMO_MODE only. Wipes state. |

Member:
| Text | Effect |
|---|---|
| `join <CODE>` then their name if not given | Adds them to the trip. |
| `stop` | Opts out permanently. Confirm once, then never message them again. |
| Anything else | Treated as an answer to their `pendingAsk`, or routed through `understand`. |

Any member may also say, in free text, that they can no longer come. `understand`
detects this as intent `drop` (section 9.5).

### Understanding replies (`llm/understand.ts`)
Input: the member's text, plus the topic of their `pendingAsk`. Output, validated with zod:

```ts
interface ParsedReply {
  intent: "answer" | "drop" | "question" | "opt_out" | "other";
  rsvp: "yes" | "no" | "maybe" | null;
  canDrive: boolean | null;
  seats: number | null;        // total seats including driver
  budgetCap: number | null;    // dollars
  itemYes: boolean | null;
  confidence: number;          // 0 to 1
}
```
- Run the keyword fallback first for trivial replies (`yes`, `yep`, `no`, `nah`, a bare
  number). Only call the LLM when the fallback is not confident. This keeps replies fast.
- Ask the model for JSON only. Strip code fences before parsing. Validate with zod.
  On failure, use the fallback result.
- The model prompt must say: extract only what the person stated; use null for anything
  not stated; never guess a number.

### Phrasing (`llm/phrase.ts`)
Input: a `MessageIntent` such as
`{ kind: "ask_drive", name: "Sam", trip: "Beach day" }`. Output: one text that follows
the voice rules. Every intent kind has a hardcoded template used when the LLM is slow or
fails. After generation, enforce in code: trim, cut to 160 characters, single message.

### Unclear replies and human handoff
- If `confidence < 0.6`: re-ask once, more simply, with an example answer
  (`sorry, didn't catch that. can you drive? yes or no works`).
- If the second reply is also unclear: stop asking that member this question, tell them
  `no worries, i'll let Priya follow up with you`, notify the organizer by DM with what
  is unresolved, and log a `handoff` event. Then continue the chain with the next person.
- If a member asks the agent a question (`intent: "question"`), answer briefly from trip
  facts only (title, date, who is organizing). If the answer isn't in the trip data, say
  so and offer to pass it to the organizer. Never invent trip details.

---

## 9. Coordination logic (the core, `engine/`)

### 9.1 Phases
1. **Collect members** (`collecting_members`): members join by code. Organizer may add
   item needs. Organizer sends `start`.
2. **RSVP and budget, in parallel**: on `start`, every member is asked RSVP at once.
   Each member who says yes is then asked for a private budget cap.
3. **Seats chain, sequential**: once at least half of members have answered RSVP, or
   `NUDGE_AFTER_SECONDS` has passed, open the seats need and run the chain.
4. **Item chains**: each item need runs its own chain, one at a time, after seats.
5. **Finalize**: when all needs are `filled` or `short` and RSVP is settled, build and
   send plans.

### 9.2 One question at a time per member
A member can have only one `pendingAsk`. Any other question for them goes into their
`askQueue` and is sent when the pending one resolves. This is what makes reply parsing
reliable: every inbound message is read as an answer to exactly one known question.

### 9.3 The chain algorithm (`chain.ts`), generic over needs
```
runChain(need):
  if need.quantityFilled >= need.quantityNeeded: mark "filled", log, stop.
  next = first phone in need.candidates that is: rsvp yes, not opted out,
         not in need.asked.
  if none: mark "short", notify organizer with the exact shortfall, log, stop.
  add next to need.asked; enqueue an Ask for that member.

onAnswer(need, member, parsed):
  seats:  if canDrive and seats >= 1 -> quantityFilled += seats, add to providers
          else add to declined
  item:   if itemYes -> quantityFilled += 1, add to providers, add label to bringing
          else add to declined
  runChain(need)   // ask the next person, or stop if filled
```
Rules:
- **Stop asking the moment the need is filled.** Members who were never asked must
  receive nothing about it. This is the feature. Test it.
- Candidate order: the organizer first, then members by join time. If a member mentioned
  a car unprompted earlier, move them to the front.
- For seats, `quantityNeeded` equals the number of members with RSVP yes. Recompute it
  whenever an RSVP changes, then call `runChain` again.
- A member who says `maybe` to RSVP counts as going for seat planning, and is told the
  plan assumes they're in.

### 9.4 Silence (`timers.ts`)
- Check every 15 seconds for stale `pendingAsk`s.
- After `NUDGE_AFTER_SECONDS` with no reply: send one gentle nudge, set `nudged = true`.
- After `GIVE_UP_AFTER_SECONDS`: do not message them again about it. For chain questions,
  treat as "no answer yet", move the chain to the next candidate. If they answer later,
  accept the answer and apply it.
- Never nudge more than once per question.

### 9.5 Dropout and changed answers
When a member says they can't come anymore:
1. Set `rsvp = "no"`. Clear their pending and queued asks. Reply kindly in one message.
2. If they were a seat provider: subtract their seats, set the seats need back to `open`,
   call `runChain`.
3. If they were bringing an item: reopen that item need and call `runChain`.
4. Recompute `quantityNeeded` for seats.
5. If the trip was already `finalized`: rebuild plans and send an update **only to
   members whose own plan changed** (new driver, new pickup). Tell the organizer always.

If a member corrects an earlier answer ("actually i can drive"), apply the new value and
re-run the affected chain the same way.

### 9.6 Finalize (`plan.ts`)
- **Seat assignment**: greedy. Each driver takes themselves, then riders are assigned in
  join order to the driver with the most free seats. Deterministic, so tests can pin it.
- **Group budget**: the minimum of all stated `budgetCap`s among members going. Shared as
  one number with no names: `everyone's comfortable up to $40`. If fewer than 2 members
  gave a cap, do not share a number at all, because it would identify the person.
- **Personalized plan DM** to each going member: the date, who they ride with or who
  rides with them, what they are bringing, and the group budget. Maximum 2 messages.
- **Organizer summary**: full roster, cars and riders, items and who brings them, the
  budget number, and anything still short.

---

## 10. Privacy and safety rules (non-negotiable, and they are part of the pitch)

1. A member's budget cap is never sent to another member, never to the organizer, and
   never shown on the dashboard. Only the group minimum is shared, under the rule in 9.6.
2. Never forward or quote one member's message to another member.
3. Only message people who texted the agent first. Never cold-text a number.
4. `stop` is honored immediately and permanently.
5. The agent always identifies itself as an AI on first contact.
6. Logs and the dashboard must not print full phone numbers. Show names, and mask numbers
   as `+1•••••0123`.
7. Add a test that fails if the string of any member's budget cap appears in a message
   sent to a different phone.

---

## 11. The dashboard ("trip board")

Purpose: a laptop screen judges watch while the phones buzz. It makes the invisible
private conversations visible without exposing private content.

- `GET /` serves `public/index.html`. `GET /events` is Server-Sent Events that pushes the
  dashboard-safe view of state after every change. `GET /api/state` returns the same JSON.
- Layout, single page, large type readable from 1.5 meters:
  - Header: trip title, date, join code.
  - Member row: one chip per member with name and status (in, out, maybe, waiting).
  - Needs: a progress bar per need (`Seats 5 / 6`, `Cooler 1 / 1`) and, under each, the
    chain as a row of names with marks: asked, said no, providing, not asked.
  - Live feed: the last 10 `LogEvent`s, newest first
    (`asked Sam to drive`, `Sam can't drive`, `asked Maya to drive`, `Maya has 4 seats`).
  - Budget: `4 of 6 answered` and the group number once allowed. Never individual values.
- Plain HTML, CSS, and a small script using `EventSource`. No framework, no build step.
- Style: clean and legible. A light sky-blue and green palette with glossy rounded cards
  is a nice nod to the hackathon's Frutiger Aero theme, but spend no more than 30 minutes
  on looks.

---

## 12. Build order and time budget

Work strictly in this order. Do not start a milestone until the previous one is committed
and pushed. Target times are Eastern, Saturday night into Sunday.

| # | Milestone | Done when | Target |
|---|---|---|---|
| 0 | Repo | Section 0 complete, repo URL printed. | 5:00 PM |
| 1 | Echo bot on real iMessage | Team texts the agent's number and gets "hello" back with a typing indicator. `message.sender` logged and the phone field confirmed. | 6:00 PM |
| 2 | Engine with fake transport | Types, store, commands, chain, plan written. `npm test` passes the tests in section 13. `npm run simulate` prints a full fake trip. | 8:30 PM |
| 3 | LLM understand and phrase | Free-text replies parse correctly, messages sound natural, fallbacks work with the API key removed. | 10:00 PM |
| 4 | Wire engine to Spectrum | A real trip runs end to end on 3 phones: join, start, RSVP, budget, seats chain, plan DMs. | 11:30 PM |
| 5 | Dashboard | Trip board updates live during a real run. | 1:00 AM |
| 6 | Silence and dropout | Nudge, give-up, dropout rebalance all work on real phones. | 2:30 AM |
| 7 | Demo hardening and docs | README finished, demo script rehearsed twice, `reset` works, seed script ready. | 4:00 AM |
| 8 | Video and submission | 2-minute video recorded, Devpost submitted with GitHub link. | Video by 8:00 AM, submit by 9:00 AM |

**Milestone 1 is the highest-risk step.** If the dashboard setup, credentials, or the
iMessage line are not working within 45 minutes, tell the user to go to the Photon
sponsor table or their Discord immediately. Meanwhile, proceed with Milestone 2, which
needs no phones.

**Cut line if behind schedule** (cut from the top down, never cut the seats chain):
1. Item chains (keep seats only).
2. Dropout after finalize (keep dropout before finalize).
3. Dashboard styling (keep the plain feed).
4. LLM phrasing (templates only; keep LLM understanding).

---

## 13. Tests that must exist and pass (`vitest`, engine only, fake transport)

1. **Chain stops when filled**: 6 members going, member 1 declines, member 2 offers 4
   seats, member 3 offers 4 seats. Assert members 4-6 received zero messages about
   driving.
2. **Chain reports shortfall**: nobody can drive. Assert the organizer gets one message
   naming the exact number of seats missing, and the need is `short`.
3. **One pending ask per member**: a member with an open RSVP question does not receive
   the drive question until RSVP is answered.
4. **Budget privacy**: the test in section 10, rule 7.
5. **Budget needs two answers**: with one cap given, no group number is sent.
6. **Dropout of a driver**: need reopens, the next candidate is asked, plans are rebuilt.
7. **Nudge once, then move on**: with fake timers, exactly one nudge, then the chain
   advances.
8. **Stop**: after `stop`, the member receives exactly one confirmation and nothing after.
9. **Unclear twice triggers handoff**: organizer is notified, chain continues.
10. **Seat assignment is deterministic**: fixed input gives the exact expected cars.
11. **State survives restart**: save, reload from `data/state.json`, continue the trip.

`scripts/simulate.ts` runs a scripted 6-person trip through the fake transport and prints
every message as `-> Sam: ...` and `<- Sam: ...`, so the conversation can be read and
tuned without phones.

---

## 14. Demo plan (build toward this exact script)

Judges arrive one at a time and have 2 minutes of demo. The script must work with **one
judge and two teammates' phones**.

Before each judge: run the seed command so a trip "Beach day" exists with the two
teammates already joined and already RSVP'd yes, both set to answer "can't drive" on cue.
Laptop shows the trip board.

1. (15 s) Pitch: the problem and the one-liner.
2. (20 s) Judge texts `join BEACH7` to the agent's number from their own phone. The agent
   greets them by name and asks if they're in. Board shows them joining.
3. (30 s) Teammate 1 is asked to drive and says no, live. The board shows the chain move.
   The **judge's phone buzzes** with the drive question.
4. (20 s) Judge answers `yeah, i have 4 seats`. Board: seats filled. Point out that
   teammate 2 was never asked.
5. (20 s) Judge receives their personalized plan. Show a teammate's different plan
   side by side.
6. (15 s) Teammate 1 texts `i can't come anymore`. The board rebalances.

Requirements this places on the build:
- `npm run seed` creates the demo trip instantly. `reset` clears it between judges.
- Every agent reply must arrive in under 4 seconds. Use the keyword fallback first and
  keep LLM prompts short.
- If the judge has no iPhone or declines to text, a third teammate phone plays that role.
- Record a clean run as a backup video in case conference Wi-Fi fails at the table.

The 2-minute submission video follows the same script, screen-recording the board with
phone screens shown beside it. Say "built on Photon's Spectrum" and "powered by Gemini"
out loud, because the rules ask teams to name sponsor technologies in the video.

---

## 15. README requirements (Milestone 7)

The README is what judges and Photon's team read after the demo. It must contain:
- The one-line pitch and a 3-sentence problem statement.
- A short "how it works" with the chained-asking explanation.
- An architecture diagram (ASCII is fine) and the "LLM reads and writes, code decides"
  design principle.
- How Spectrum is used: which calls, and why the design is DM-first.
- The privacy and safety rules from section 10.
- Setup: clone, `npm install`, copy `.env.example` to `.env`, fill keys, `npm run dev`.
- How to run the simulator and tests without any credentials.
- Tracks entered and what's next (group chat presence with a dedicated line, calendar
  holds, cost splitting, WhatsApp through the same Spectrum code).

---

## 16. Stretch goals (only after Milestone 7 is committed)

- **S1 Group presence**: if Photon staff confirm a dedicated line for our project, let
  the agent post the final summary into an existing group chat. Ask them first; do not
  spend time on this otherwise.
- **S2 Tapbacks**: react to a member's answer with a thumbs-up instead of sending a text
  reply, once the reaction call is verified in the docs.
- **S3 Date voting**: collect each member's free dates privately and pick the best one.
- **S4 Cost split**: estimate gas per car and tell each person what they owe.
- **S5 Second channel**: add another Spectrum provider to show the same agent working
  across platforms with the same engine.

---

## 17. How to work with this team

- The team is new to this stack. Explain every command you ask them to run in one plain
  sentence, and say what a successful result looks like.
- When something needs a human (dashboard signup, promo code, API keys, texting from a
  phone), stop and give numbered steps. Never ask them to paste a secret into the chat;
  tell them to put it in `.env`.
- Keep functions small and name things plainly. Add a short comment at the top of each
  file saying what it is for. Teammates must be able to answer judges' questions about
  the code.
- After each milestone, give a 3-line status: what works, what was verified and how,
  what is next.
- Never claim something works unless you ran it. If it was only tested with the fake
  transport, say so.
- If a decision is not covered here, choose the option that protects the demo script in
  section 14, and note the decision in the commit message.