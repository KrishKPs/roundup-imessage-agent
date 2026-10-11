# Roundup

**An AI that plans your group trip by texting everyone 1:1 in iMessage, so the group chat doesn't have to.**

We built Roundup at HackNC 2026 for the Photon track. It runs on Photon's Spectrum and talks through Claude.

- **Try it:** https://roundup-bot-production.up.railway.app/app (open it in Safari on your iPhone, then Share → Add to Home Screen)
- **Watch it work:** https://roundup-bot-production.up.railway.app

---

## Why we built this

Every one of us has been in the 15-person group chat for a trip that never quite comes together. Someone asks who's driving, it gets buried under memes, someone asks again two hours later, nobody wants to say "i can only spend $20" in front of everyone, and one person ends up doing all the work.

So we thought: what if the planning happened somewhere else? Everyone talks to one assistant privately, it does the chasing, and the group chat gets to stay fun.

## What it does

**For the organizer:** you create a trip in one form (or one text), share a single link, and you're done chasing people. You can talk to Roundup like a friend:

- "ask Sam if he can bring the tent"
- "figure out when everyone's free this week"
- "tell everyone to bring sunscreen"
- "push it to sunday 11am"

Questions go out to people privately, and you get one summary back, like *"sunday works for all three, Leo's free after 12"*.

**For everyone else:** you tap the link, send one text, and you're in. From then on Roundup texts you privately, one quick question at a time, in a normal human voice:

- what's the most you'd want to spend (only Roundup sees it)
- any chance you can drive?
- could you bring the cooler?

**Chained asking, the core idea.** Roundup asks one person if they can drive. If they say no, it asks the next person, and the moment there are enough seats it **stops**. Nobody else gets bothered. The same goes for every item on the list. If someone says "i'd rather not, but i can if nobody else does", they become the backup and only get asked again if it's actually needed.

**The plan.** Roundup asks the organizer a few setup questions (where, when, the vibe) and asks each person what they're hoping to do and anything it should plan around. It drafts the day, the organizer says "yes" or edits it by text, and everyone gets their own plan (their ride, what they're bringing) plus a link to a Plan page and a PDF that's always the latest version.

**When things change**, like someone dropping out or a driver cancelling, Roundup reworks the plan and texts only the people whose plan actually changed.

## How it works

```
iMessage  <->  Photon Spectrum (spectrum-ts)  <->  transport/spectrum.ts
                                                        |
                                              engine (deterministic code)
                                     who to ask next, chains, seats, budgets, plans
                                        |            |             |
                               llm/understand   llm/phrase   llm/converse, llm/itinerary
                               (reply -> JSON)  (intent -> text)   (Claude reads/writes text)
                                        |
                              store (JSON file on a volume)
                                        |
                  web: switchboard (live), Plan page, PDF, create page, phone app (PWA)
```

The rule we stuck to: **the AI reads and writes text, the code makes the decisions.** Who gets asked next, the seat math, when a need is filled and who gets which message are all plain deterministic code. Claude only turns a messy reply ("yeah as long as we're back by 8") into structured data, and turns "ask about driving" into a text that sounds like a person.

We also don't trust the model blindly. Every message is checked before it goes out:

- no made-up times, prices or places
- the first text always says it's an AI and how to stop
- one question per message
- budgets never leak

If the model is slow or down, the bot falls back to keyword parsing and fixed templates, so it never just hangs.

## How we use Spectrum

- `Spectrum({ providers: [imessage.config()] })` connects to Photon's iMessage lines, and `app.messages` streams every incoming text.
- `space.responding(...)` shows the typing bubble while Roundup thinks, and `space.send(...)` replies in the same chat.
- `imessage(app).user(phone)` plus `im.space.create(user)` opens 1:1 chats, and `imessage(message).sender.address` tells us who's texting.
- **Why it's all DMs:** the shared Photon lines can't create group chats, and a number has to be registered before it can reach the agent. So when someone signs up through the trip link, we register them through the Photon CLI, route them to their own line, and have them send the first text. Honestly, 1:1 is the whole point anyway.

## Privacy

We cared about this a lot, because the whole pitch is "say things privately".

1. **Your budget is never shown to anyone**, not even the organizer. The group only sees the lowest number, and only once at least two people have answered, so nobody can be singled out.
2. **Things like dietary needs or "i can't do long walks" are private too.** The planner only sees counts ("2 vegetarian"), never names.
3. **Roundup never forwards one person's messages to another.** If you ask something only the organizer can answer, the organizer gets a short summary, and you're told first.
4. **The first text always says it's an AI**, and replying `stop` ends it immediately and permanently.
5. **It only texts people who joined** or were added by the organizer.
6. **The public pages** (the live board, the Plan page, the PDF) use first names only: no phone numbers, no message text.
7. **Simulated people on the demo board are always labeled "sim"** and are never texted. We use them to show what a 15-person trip looks like.

Each of these has an automated test.

## Run it yourself

You need Node 20 or newer.

```bash
git clone https://github.com/KrishKPs/roundup-imessage-agent.git
cd roundup-imessage-agent
npm install
cp .env.example .env    # fill in your keys
npm run dev             # bot + web pages on http://localhost:3010
```

| Key | What it's for |
|---|---|
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | your Photon project (Photon dashboard → Settings) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude; without it the bot still works with keywords and templates |
| `DEMO_MODE` | turns on reset/seed and the demo controls |
| `TUNNEL` / `PUBLIC_URL` | a public address for trip links |
| `IMESSAGE_MODE` | `cloud` (Photon lines) or `local` (a Mac's Messages app) |

Run `npx photon login` once so Roundup can register new numbers.

**You can try a lot without any keys:**

```bash
npm test            # 92 tests on the engine with a fake iMessage
npm run board       # the live board with simulated people: http://localhost:3011
npm run simulate    # a whole trip printed in your terminal
npm run eval        # 46 real texts through the model, graded by code (needs a model key)
```

We deploy it on Railway with a persistent volume; the `Dockerfile` and `railway.json` are in the repo.

## How we built it, and where AI was used

**What we did:**
- **We designed the product and wrote the specs** for it (`CLAUDE.md`, `Dashboard.md`, the plan spec): chained asking, "joining means you're in", the privacy rules, the organizer controls, the Plan page and the live board.
- **We made the product calls:** what to build, what to cut, and how it should sound. We put together 500 example conversations to pin down the voice.
- **We tested it on real phones with real friends through the night**, and turned every awkward reply into a fix and a test case.

**AI tools we used:**
- **Claude Code** (Anthropic) was our coding assistant. We had it implement our specs, debug against our phone tests, deploy, and help write the docs. It wrote most of the TypeScript, and the commit history credits it as co-author.
- **Claude Opus 5.5** runs inside Roundup. It reads replies and rewords messages so they sound human. It never makes decisions; all of that is code.

## Track

**Photon:** a multi-person agent on iMessage built with Spectrum.
- **Real human-in-the-loop:** the organizer approves the plan, and members answer privately.
- **Memory across people and time:** Roundup remembers who said what and adapts when things change.
- **Helps without being annoying:** it stops asking the moment a need is filled.
- **Safety built in:** it says it's an AI, `stop` works, and budgets stay private.

## What's next

- Posting the final plan into your existing group chat once we have a dedicated Photon line
- Real place suggestions (from OpenStreetMap) and private votes on where to eat
- Weather-aware plans, day-of reminders, and "running late" texts that go straight to your driver
- Splitting gas and costs after the trip
- WhatsApp and other apps through the same Spectrum code
