# Devpost submission draft: Roundup

Paste each section into the matching Devpost field.

---

## Project name
Roundup

## Tagline (short)
An AI that plans your group trip by texting everyone 1:1 in iMessage, so the group chat doesn't have to.

## Links
- GitHub: https://github.com/KrishKPs/roundup-imessage-agent
- Try it (organizer app, add to home screen from Safari): https://roundup-bot-production.up.railway.app/app
- Live switchboard: https://roundup-bot-production.up.railway.app
- Demo video: (add the 2-minute video link here before final submit)

---

## Inspiration
Planning a trip with 15 friends in one group chat always goes the same way: messages get buried, the same question gets asked five times, nobody wants to say their real budget in front of everyone, and one person ends up doing all the organizing. We wanted the group chat to stay fun and have the logistics happen somewhere else.

## What it does
Roundup is an AI agent with a real iMessage number. The organizer creates a trip (in one text, or one tap in the app) and shares a single link. Everyone who joins gets their own private 1:1 conversation with Roundup, and from then on Roundup does the coordinating:

- **Chained asking.** It asks one person "any chance you can drive?" If they say no, it asks the next person, and the moment there are enough seats it stops. Nobody else gets bothered. The same works for "who can bring a cooler / speaker / tent".
- **Private budgets.** Each person tells Roundup their max spend privately. Only the group's lowest number is ever shared, and only once at least two people have answered, so nobody can be identified.
- **Talks like a friend, not a form.** It reads free-text replies ("yeah as long as we're back by 8", "id rather not drive but i can if no one else does", "10 💀") and answers in short casual texts. A catch like "back by 8" gets passed to the organizer; a reluctant driver becomes the backup and is only asked again if nobody else can drive.
- **Plain-English organizer controls.** "ask Sam if he can bring the tent", "figure out when everyone's free this week", "tell everyone to bring sunscreen", "push it to sunday 11am". Questions go out 1:1, and the organizer gets one summary back ("sunday works for everyone, Leo's free after 12").
- **Itinerary.** "make the itinerary" drafts a day plan from everything Roundup collected (rides, items, answers, heads-ups like "no peanuts"), the organizer edits it by text, and "send it" gives each person their own plan plus a shareable trip page.
- **The switchboard.** A live board shows many private conversations happening at once without showing what anyone said: one agent in the middle, people around it, a question visibly hopping from person to person, and a big "0 messages in the group chat".

## How we built it
- **Photon Spectrum (`spectrum-ts`)** with the cloud iMessage provider: receiving DMs, the typing indicator while it replies, and opening 1:1 conversations. Because the shared-pool lines can't create group chats, the whole product is DM-first, which is the point.
- **Coordination is deterministic code; the AI only reads and writes text.** The engine (TypeScript, Node) decides whom to ask next, does the arithmetic, and decides when a need is filled. Claude (Anthropic API) turns replies into validated JSON and turns structured "say this" intents into natural texts. Every model output is checked in code: no invented numbers, times or prices, the AI disclosure is always kept, one question per message, budgets never leak, and the model's notes-to-self are blocked. If the model is slow or fails, keyword parsing and fixed templates take over, so the bot never stalls.
- **Voice from real examples.** We wrote 500 human-style example conversations and used them for few-shot examples and the style rules (lowercase, ~30 characters, no emoji), and as a reply bank for simulated crowd members.
- **Testing:** 74 automated tests on the engine (chain stops when filled, shortfall reporting, budget privacy, dropout rebalancing, nudges, stop), plus a 46-case conversation eval that runs realistic texts through the real model and grades each reply in code.
- **Web side:** Express + Server-Sent Events, plain HTML/CSS/SVG (no framework), installable as a phone app (PWA). Deployed on Railway with a persistent volume.

## Challenges we ran into
- Photon's shared-pool lines can't text someone first, and only registered numbers can reach the bot. We built a join flow around that: the organizer shares one link, each person signs up and texts in once, and Roundup registers their number and routes them to their own line behind the scenes.
- Making an LLM sound human without letting it make things up. We ended up with code checks on every message and an eval set that catches regressions (like the model writing "wait, let me fix that" into a text).
- Venue Wi-Fi blocked our tunnel, so we moved the bot to Railway.

## Accomplishments that we're proud of
- The chained-asking moment: the question hops from person to person and stops the instant it's answered, and you can watch it happen on the switchboard.
- Privacy as a feature you can see: shuffled padlocks for budgets, organizer-only summaries, no phone numbers or message text anywhere on the board.
- It runs for real on iMessage, with real phones.

## What we learned
Keeping "who decides" in code and "how it sounds" in the model made the agent both trustworthy and natural. And a good group-chat assistant mostly needs to know when not to send a message.

## What's next for Roundup
- Posting the final plan into the existing group chat once we have a dedicated Photon line.
- Calendar holds, splitting gas and costs after the trip, and day-of reminders ("Sam's outside at 12:30").
- WhatsApp and other channels through the same Spectrum code.

## Built with
typescript, node.js, photon-spectrum, imessage, claude, anthropic-api, express, server-sent-events, html, css, svg, pwa, railway, vitest, zod

## Notes for judges (optional field)
- Crowd mode on the switchboard uses simulated members to show 15+ people at once; they are always labeled "sim" and never texted.
- Every first message says it's an AI and how to stop; "stop" is honored immediately and permanently.
