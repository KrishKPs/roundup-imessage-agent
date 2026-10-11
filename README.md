# Roundup

**An AI that plans your group trip by texting everyone 1:1 in iMessage, so the group chat doesn't have to.**

Built at HackNC 2026 for the **Photon track**, on Photon's Spectrum (`spectrum-ts`), powered by Claude (Anthropic).

- **Try it:** https://roundup-bot-production.up.railway.app/app (open in Safari on an iPhone, then Share → Add to Home Screen)
- **Live switchboard:** https://roundup-bot-production.up.railway.app
- **Demo video:** _add link_

---

## The problem

Planning a trip for 15 people in one group chat breaks down fast. Messages get buried, the same question is asked five times, nobody says their real budget in front of everyone, and one person ends up doing all the organizing.

Roundup moves the logistics out of the group chat. Everyone talks to Roundup privately, Roundup does the coordinating, and the group chat stays fun.

## How it works

1. **The organizer creates a trip** with one form or one text. They pick what Roundup should sort out (rides, private budgets, things to bring) and can add details the bot may answer from (leave time, meeting spot).
2. **They share one link.** Each friend taps it, types their name and number, and sends one pre-written iMessage. Joining means they're in.
3. **Roundup texts each person privately**, one question at a time, in a casual voice: their max budget (private), whether they can drive, whether they can bring the cooler.
4. **Chained asking.** Roundup asks one person "any chance you can drive?" If they say no, it asks the next person, and **the moment there are enough seats it stops**. Nobody else is bothered. The same works for every item. Someone who says "i'd rather not, but i can if nobody else does" becomes the backup and is asked again only if no one else can.
5. **The organizer talks to it in plain English:** "ask Sam if he can bring the tent", "figure out when everyone's free this week", "tell everyone to bring sunscreen", "push it to sunday 11am". Questions go out 1:1 and come back as one summary ("sunday works for all three, Leo's free after 12").
6. **The plan.** After a short setup interview with the organizer and two optional questions to each member (what they're hoping to do; anything to plan around, which stays private), Roundup drafts the day. The organizer says "yes" or edits by text, and everyone gets their own plan plus a link to the **Plan page** and an always-current **PDF**.
7. **Things change.** Someone drops out, a driver cancels, the time moves. Roundup reworks the plan and texts only the people whose own plan changed.

## Architecture

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
                  dashboard: switchboard (SSE), Plan page, PDF, create page, phone app (PWA)
```

**The design rule: the language model only reads and writes text; code makes every decision.** The engine decides whom to ask next, does all the arithmetic, and decides when a need is filled. Claude turns a free-text reply into validated JSON (`zod`), and turns a structured "say this" instruction into a short, natural text. Every model output is checked in code before it is sent:

- no numbers, times, prices or places that aren't in the trip facts
- the first message always says it's an AI and how to stop
- one question per message
- budgets never leak
- the model's notes to itself ("let me fix that") never reach a phone

If the model is slow or fails, keyword parsing and fixed templates take over, so the bot never stalls.

## How Spectrum is used

- `Spectrum({ providers: [imessage.config()] })` connects to Photon's cloud iMessage lines. `app.messages` streams every inbound DM.
- `space.responding(...)` shows the typing indicator while Roundup works on a reply, and `space.send(...)` replies in the same DM.
- `imessage(app).user(phone)` + `im.space.create(user)` opens 1:1 conversations, `imessage(space).type` keeps it DM-only, and `imessage(message).sender.address` identifies who's texting.
- **Why DM-first:** Photon's shared-pool lines can't create group chats, and a number must be a registered project user before it can reach the agent. So the website registers each person (via the Photon CLI) when they sign up, routes them to their own pool line, and has them send the first text. One-on-one coordination is the product anyway.
- A local provider (`@spectrum-ts/imessage-local`) is also supported through the same engine for testing (`IMESSAGE_MODE=local`).

## Privacy and safety

1. **A member's budget is never shown to anyone**, including the organizer, the dashboard, the Plan page and the PDF. Only the group's lowest number is shared, and only after at least two people answer, so nobody can be identified.
2. **Private needs** (food needs, mobility, timing) are treated like budgets. The planner and the organizer only see counts ("2 vegetarian"), never names.
3. **Messages are never forwarded between members.** When a member asks something only the organizer can answer, or shares a heads-up, the organizer alone gets a short summary, after the member is told.
4. **Every first message says it's an AI**, who added them, and how to stop. `stop` is honored immediately and permanently.
5. **Roundup only texts people who texted it first** (or were added by the organizer).
6. **The public pages** (switchboard, Plan page, PDF) show first names only: no phone numbers, no message text.
7. **Crowd mode is labeled.** The switchboard can add simulated members to show 15+ people at once. They are always labeled `sim`, are never texted, and answer with lines from our example conversations.

There are automated tests for each of these.

## Run it yourself

Requirements: Node 20+.

```bash
git clone https://github.com/KrishKPs/roundup-imessage-agent.git
cd roundup-imessage-agent
npm install
cp .env.example .env    # then fill in the keys below
npm run dev             # the bot + dashboard on http://localhost:3010
```

`.env` keys:

| Key | What it's for |
|---|---|
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon project credentials (Photon dashboard → Settings) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude; optional, without it the bot uses keywords and fixed templates |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | alternative model if no Anthropic key |
| `DEMO_MODE` | enables reset/seed and the demo bar |
| `TUNNEL` / `PUBLIC_URL` | public address for trip links (free cloudflared tunnel, or a fixed URL) |
| `IMESSAGE_MODE` | `cloud` (Photon lines) or `local` (this Mac's Messages app) |

New numbers are registered with `npx photon login` once, after which Roundup registers people automatically.

**No credentials needed for these:**

```bash
npm test            # 92 engine tests on a fake transport
npm run board       # offline switchboard with simulated crowd members: http://localhost:3011
npm run simulate    # a scripted trip printed in the terminal
npm run eval        # 46 realistic texts through the real model, graded by code (needs a model key)
```

**Deploying:** the repo includes a `Dockerfile`, `railway.json` and `fly.toml`. Our live copy runs on Railway with a persistent volume.

## How we built it, and where AI was used

**Our team** came up with the idea and owned the product:
- **We designed the product and wrote the specs** (`CLAUDE.md`, `Dashboard.md`, the plan spec): the chained-asking algorithm, the "joining means you're in" flow, the private-budget and privacy rules, the organizer controls, the Plan page and the switchboard.
- **We made every product call:** what to build, what to cut, and how it should sound (we put together the 500 example conversations that set the voice).
- **We tested it with real people on real phones all night**, and turned what went wrong into fixes and new test cases.

**AI tools we used:**
- **Claude Code** (Anthropic) was our coding assistant. We directed it to implement the specs, debug against our phone tests, and deploy. It wrote most of the TypeScript in this repo; the commit history credits it as co-author.
- **Claude Opus 5.5** runs inside the product. It reads free-text replies and rewords messages so they sound human. It never makes decisions: who gets asked, seats, budgets and who gets which text are all deterministic code, and every model output is checked before it's sent.

## Tracks

- **Photon:** a multi-person iMessage agent on Spectrum, with real human-in-the-loop collaboration (the organizer approves the plan; members answer privately), context that persists across people and time, an agent that helps without demanding attention (stops asking the moment a need is filled), and safety behaviors (AI disclosure, `stop`, private budgets).

## What's next

- Posting the final summary into an existing group chat once we have a dedicated Photon line
- Real place suggestions from a named source (OpenStreetMap) and private votes on options
- Weather-aware plans, day-of reminders, and "running late" relays to your driver
- Splitting gas and costs after the trip
- WhatsApp and other channels through the same Spectrum code
