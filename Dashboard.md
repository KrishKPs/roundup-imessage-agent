# dashboard.md — the Roundup "Switchboard"

Spec for the web side of Roundup. Read all of it, then read the existing code before
changing anything. This file extends CLAUDE.md; where they disagree about the dashboard,
this file wins. Everything else in CLAUDE.md (privacy rules, engine design, deadline)
still applies.

**Adapt to the code that exists.** File names and types below follow CLAUDE.md. If the
real code differs, keep the real names and map this spec onto them. Do not rewrite the
engine to fit this document.

---

## 1. The idea

The product has no app. Members only ever use iMessage. So the web page is not "the app";
it is the **window into what the agent is doing**: a live switchboard that shows 15-20
private conversations happening at once, without showing what anyone said.

A judge standing at the table should understand the whole product in five seconds of
looking at the screen: one agent in the middle, people around it, private lines lighting
up, a question hopping from person to person until it is answered, then stopping.

Three things the page must make visible, because they are the pitch:

1. **Parallel private conversations** (many lines pulsing at once).
2. **Chained asking** (a question visibly hops from one person to the next and stops).
3. **Restraint** (a counter of people the agent never had to bother).

---

## 2. Hard limits

| Limit | Detail |
|---|---|
| Time | It is late Saturday. Submission is Sunday 10:00 AM. Budget for this whole file: **3 hours**, in the tiers in section 13. Stop at the tier the clock allows. |
| Stack | One HTML file, one CSS block, one script. Plain JS and inline SVG. **No framework, no build step, no CDN** (venue Wi-Fi may fail; the page must work offline against localhost). |
| Screen | A laptop at a demo table, viewed from 1.5 meters, possibly in a bright room. Design for 1440x900 and 1280x720. No scrolling on the main view. |
| Read-only | The page displays state. The only controls are the demo bar in section 11, and they exist only when `DEMO_MODE=true`. |
| Privacy | Section 12. A violation here is worse than a missing feature. |
| Engine untouched | The dashboard reads a view of state. It never changes coordination logic. |

---

## 3. Where the example data is used

There are two data files. Each has one job.

| File | What it is | Job |
|---|---|---|
| `human_conversations_500.jsonl` | 500 tagged conversations in the target voice | **Voice.** At reply time, pick 5 conversations whose tags match the situation and put them in the phrase prompt (already specified to the team). The dashboard shows which ones were used (section 9, "Why it said that"). |
| `roundup_examples.json` → `understand` | 391 member texts, each with the topic it answers and the parsed result | **Crowd simulator.** Simulated members reply with real-sounding texts from this bank, chosen by topic and by the answer their persona would give (section 10). Also the parser accuracy test. |

Both files must be committed (not under the ignored `data/` folder unless un-ignored).

---

## 4. Server contract

Keep the existing `express` server. Provide these routes.

| Route | Purpose |
|---|---|
| `GET /` | The switchboard page. |
| `GET /events` | Server-Sent Events. Sends `state` (full snapshot) on connect and after every change, and `pulse` for each message sent or received. |
| `GET /api/state` | The same snapshot as JSON, for debugging. |
| `POST /api/demo/:action` | Demo bar actions (section 11). Returns 404 unless `DEMO_MODE=true`. Bind the server to `127.0.0.1` so nobody on the venue network can call it. |

### 4.1 The snapshot (`DashboardView`)

Build it in one function, `toDashboardView(trip)`, in `dashboard/view.ts`. This function
is the **only** place state is turned into something public. Everything the page shows
comes from it.

```ts
interface DashboardView {
  trip: {
    title: string; dateText: string | null; code: string;
    status: "collecting_members" | "coordinating" | "finalized";
    joinLink: string | null;        // sms: link for the QR code, section 8.6
  } | null;                         // null = no trip yet, show the empty state
  members: Array<{
    id: string;                     // short random id. NEVER the phone number.
    name: string;                   // first name only
    initials: string;
    isOrganizer: boolean;
    simulated: boolean;
    rsvp: "unknown" | "yes" | "no" | "maybe";
    mood: "idle" | "waiting" | "answered" | "providing" | "declined" | "dropped" | "opted_out";
    waitingOn: "rsvp" | "budget" | "drive" | "item" | null;  // topic only, never the text
    carId: string | null;
    bringing: string[];
  }>;
  needs: Array<{
    id: string; kind: "seats" | "item"; label: string;
    needed: number; filled: number;
    status: "open" | "filled" | "short";
    chain: Array<{ memberId: string; result: "asking" | "declined" | "providing" | "no_answer" }>;
    neverAsked: string[];           // going members who were not bothered
  }>;
  cars: Array<{ id: string; driverId: string; seats: number; riderIds: string[] }>;
  budget: { answered: number; going: number; groupCap: number | null };
  stats: {
    privateTexts: number;           // all DMs in and out
    peopleNotBothered: number;      // sum of neverAsked across filled needs
    questionsAsked: number;
    carsOnRoad: number;             // cars.length
    carsAvoided: number;            // going - carsOnRoad, min 0
    co2SavedKg: number | null;      // section 8.7; null if no distance known
  };
  feed: Array<{ at: number; kind: string; text: string; memberId: string | null }>; // last 30
  lastReply: { memberId: string; tags: string[]; exampleIds: number[] } | null;      // section 9
}
```

Rules for `toDashboardView`:
- Member ids are generated once per member and stored; they are not derived from the phone.
- `budget.groupCap` follows the engine's rule: null unless at least 2 going members answered.
- Feed text is written by the engine as plain summaries (`asked sam to drive`,
  `sam can't drive`, `maya has 4 seats`). It never contains a member's actual words and
  never contains a dollar amount tied to a person.
- `mood` mapping: `opted_out` if opted out; `dropped` if rsvp went yes→no; `waiting` if
  `pendingAsk` exists; `providing` if they provide seats or an item; `declined` if they
  declined the most recent chain question; `answered` if rsvp is known; else `idle`.

### 4.2 Pulses

```ts
interface Pulse { memberId: string; direction: "out" | "in"; topic: string | null; at: number }
```
Emit one from the transport wrapper every time a DM is sent (`out`) or received (`in`).
Pulses drive the animation only; if one is lost nothing breaks.

### 4.3 Client connection

Use `EventSource("/events")`. On error, show a small "reconnecting" chip and let
`EventSource` retry. On every `state` event, re-render from the snapshot (state is small;
no diffing library). Keep SVG node positions stable by keying on `member.id`.

---

## 5. Layout

One screen, three columns, no scrolling.

```
+----------------------------------------------------------------------------------+
|  Roundup   Beach day · Saturday            [coordinating]        join: BEACH7 [QR]|
+----------------------------------------------------------------------------------+
|  STATS                 |                                    |  NEEDS             |
|  214 private texts     |            o  o   o                |  Seats   5 / 6     |
|  0 group messages      |         o     |      o             |  [#####-]          |
|  9 people not bothered |       o ---- (R) ---- o            |  sam x  maya ✓ ... |
|  2 cars, not 6         |         o     |      o             |                    |
|  ----------------      |            o  o   o                |  Cooler  1 / 1     |
|  BUDGET                |                                    |  [######]          |
|  4 of 6 answered  🔒   |         THE SWITCHBOARD            |  jo x  ana ✓       |
|  group cap: $30        |                                    |  ----------------  |
|                        |                                    |  CARS              |
|                        |                                    |  [maya: s j a _]   |
+------------------------+------------------------------------+--------------------+
|  LIVE FEED:  maya has 4 seats · asked maya to drive · sam can't drive · ...       |
+----------------------------------------------------------------------------------+
```

Column widths: 22% / 48% / 30%. The feed is a single-line ticker along the bottom
(newest on the left) so it never pushes content down.

Before a trip exists: show the product name, the one-line pitch, and "text **new trip
beach day on saturday** to start". Before `start`: show the QR code large in the center
with "text **join BEACH7**", and members appear around it as they join.

---

## 6. The switchboard (center, the main event)

An inline SVG that fills the center column.

**Structure**
- The agent is a circle in the center labeled "R", gently "breathing" (scale 1.0 to 1.04
  on a 4-second loop).
- Each member is a node on a ring around it. Angle = index / count * 360°, starting at
  the top, in join order. The organizer's node has a small crown mark and sits at the top.
- With more than 12 members use two rings (inner ring radius 62% of the outer) so labels
  do not collide. Node radius scales down from 34px (≤8 members) to 22px (20 members).
- A thin line connects each node to the center. Lines are faint until used.
- Each node shows initials inside and the first name underneath. Simulated members get a
  dashed outline and a tiny "sim" tag (section 10).

**Node appearance by `mood`** (color is never the only signal; each has a mark too)

| mood | Fill | Mark |
|---|---|---|
| idle | pale glass | none |
| waiting | sky blue, slow pulse ring | "…" typing dots |
| answered | soft green | check |
| providing | strong green, glow | car icon (seats) or box icon (item) |
| declined | pale grey | small dash |
| dropped | faded, 40% opacity | struck-through name |
| opted_out | hidden line, grey node | "stop" mark |

RSVP "no" members drift to a smaller size but stay on the ring, so the count of people
is always honest.

**Animations**
- **Pulse out**: on an `out` pulse, a bright dot travels from the center to the node
  along its line in 500ms, and the line glows for 1.5s.
- **Pulse in**: on an `in` pulse, a dot travels from the node to the center, and the
  center circle flashes once.
- **The hop (most important animation)**: when a chain question moves from one member to
  the next, draw a curved arc *around the ring* from the previous node to the next node,
  with a dot travelling along it in 700ms. The previous node settles to `declined`; the
  next goes to `waiting`. The arc fades over 3s. This is the visual for "sam said no, so
  it asked maya".
- **The stop**: when a need becomes `filled`, the providing node glows, and every node
  in `neverAsked` gets a brief soft halo with a floating "not bothered" label for 2s.
  This is the visual for restraint.
- **Dropout**: node fades; if they were a driver, their riders' nodes shake once and the
  hop animation runs again as the chain restarts.
- Respect `prefers-reduced-motion`: replace travel animations with a simple highlight.
- Only animate `transform` and `opacity`. No layout-triggering animation.

**Topic label**: while a member is `waiting`, show a small chip near their node with the
topic word only: `rsvp`, `budget 🔒`, `drive`, or the item name. Never the message text.

---

## 7. Left column: stats and budget

Large numerals, small labels. These four numbers are the pitch in data form.

| Stat | Source | Label |
|---|---|---|
| Private texts | `stats.privateTexts` | "private texts" |
| Group messages | always the literal `0` | "messages in the group chat" |
| People not bothered | `stats.peopleNotBothered` | "people the agent never had to ask" |
| Cars | `stats.carsOnRoad`, `stats.carsAvoided` | "2 cars on the road, 4 avoided" |

Numbers count up when they change (300ms). The "0" is static and deliberately the
largest numeral on the page.

**Budget card (the privacy feature made visible)**
- A row of padlock icons, one per going member. A padlock fills in when that member has
  answered. The icons are in a **random order that is reshuffled on every render**, so a
  viewer cannot map a padlock to a person.
- Text: `4 of 6 answered`.
- When `groupCap` is not null: `everyone's comfortable up to $30`.
- When it is null: `group number appears after 2 answers`.
- A one-line caption: `individual budgets never leave the private chat`.

---

## 8. Right column and extras

### 8.1 Needs
One card per need: label, `filled / needed`, a progress bar, and the chain as a row of
small name chips in the order asked, each marked `asking`, `declined`, `providing`, or
`no answer`. After the chain, a dimmed group `+3 not asked`. A `short` need shows an
amber card with `2 seats short, organizer notified`.

### 8.2 Cars
Appears once any driver exists. One small card per car: the driver's initials on the
left, then one slot per seat. Filled slots show rider initials; empty slots are outlines.
After finalize, riders animate into their slots one at a time (150ms apart).

### 8.3 Status chip
In the header: `collecting members`, `coordinating`, or `plan sent`. On `finalized`, the
whole board gets one short celebration (a few bubbles rise, 2 seconds) and the header
shows `plan sent to 6 people · each one different`.

### 8.4 Live feed ticker
Bottom strip. Newest left. Each item has a small icon by kind and a relative time
(`12s`). Clicking an item highlights that member's node. Maximum 30 kept.

### 8.5 Personal plan cards (after finalize)
Clicking a node opens a small card: who they ride with or drive, and what they bring,
styled like an iMessage bubble. It shows the plan facts only, **not** their budget and
not their messages. This lets a presenter show "everyone got a different plan".

### 8.6 Join by QR code
The header shows a QR code that opens iMessage with the join text already typed.

- Link format: `sms:<AGENT_NUMBER>&body=join%20<CODE>` (iOS). Read `AGENT_NUMBER` from
  an env variable the team fills in with the number they currently text.
- If `AGENT_NUMBER` is empty, show the text `text "join BEACH7" to the Roundup number`
  and no QR.
- Generate the QR without a network call: vendor one small MIT-licensed QR generator
  file into `dashboard/public/` (for example `qrcode-generator`), or install it with npm
  and serve it locally. Do not load it from a CDN.
- **Check with a real phone** that scanning opens Messages with the body filled in. On
  the shared-pool plan, confirm with Photon's staff that a new person texting that number
  reaches this project. If either check fails, fall back to the plain text instruction.

### 8.7 Carpool impact (optional, small)
A line under the cars stat: `about 38 kg of CO2 avoided by sharing rides`.

- `carsAvoided = going − carsOnRoad` (comparison: everyone driving alone).
- `co2SavedKg = carsAvoided × roundTripMiles × 0.4`. The 0.4 kg per mile factor is the
  commonly cited US EPA figure for a typical passenger car (about 400 g per mile);
  confirm the number on epa.gov before putting it in the README.
- `roundTripMiles` comes from an organizer command `distance <miles>`. If the organizer
  never sets it, `co2SavedKg` is null and the line is hidden. Do not invent a distance.
- Always label it "about" and "estimate".

This also gives the project an honest link to the hackathon's Frutiger Aero track
(technology and nature together). Whether carpooling is enough of a sustainability angle
to enter that track is the organizers' call; ask before selecting it on Devpost.

---

## 9. "Why it said that" (explainability drawer)

A small tab on the right edge opens a drawer. It shows, for the most recent bot reply:
- the situation tags the engine chose (for example `drive_no`, `tangent`),
- the ids of the example conversations pulled from `human_conversations_500.jsonl`,
- the first two lines of each of those examples.

It does **not** show the member's message or the bot's actual reply. Its purpose is to
let the team answer "how does it sound so natural?" by showing that the voice comes from
matched examples while the decision came from code. Populate `lastReply` from the phrase
step. Closed by default.

---

## 10. Crowd mode: simulated members

The pitch is 15-20 people. The team has three phones. Crowd mode fills the ring with
simulated members so the switchboard shows the real scale, while the real phones (the
judge and teammates) take part in the same trip.

**Honesty rule: simulated members are always labeled.** Dashed outline and a "sim" tag
on every simulated node, plus a header chip `12 simulated · 3 real`. The presenter says
so out loud. Never present simulated people as real users. Put this in the README too.

**How it works**
- `SimTransport` wraps the real transport. If the recipient is a simulated member, the
  message is **not** sent through Spectrum. Instead a reply is scheduled.
- Simulated members have ids like `sim:1` instead of phone numbers, so no code path can
  text a real number for them.
- Each simulated member gets a persona at creation, from a seeded random generator so
  runs are repeatable: `rsvp` (70% yes, 15% maybe, 15% no), `canDrive` (25% yes, with 4
  or 5 seats), `budgetCap` (one of 15, 20, 25, 30, 40, 50, 60), `hasItems` (30% each),
  `replyDelayMs` (2000-7000), and 10% are "slow" (never reply, to trigger a nudge).
- When a question on topic T arrives, pick a reply text from `roundup_examples.json` →
  `understand` where `topic === T`, `parsed.confidence >= 0.9`, and the parsed values
  match the persona's answer (for example topic `drive`, `canDrive: false`). Choose at
  random among matches with the seeded generator. If none match, use a plain `yes`/`no`.
- After `replyDelayMs`, feed the text into `engine.handleInbound(simId, text)` exactly
  as a real message would arrive. The normal understand step parses it. This means crowd
  mode also exercises the real parser on 300+ phrasings.
- Emit pulses for simulated messages like any others.

**Making the chain reach the judge**
In crowd mode the demo should still hop to a real phone. Add a demo setting
`DEMO_CHAIN_TARGET=real`: when ordering seat candidates, simulated members who cannot
drive go first, then the real members, then simulated drivers. The chain then visibly
hops through two or three simulated "no" answers and lands on a real phone. This changes
only candidate **order**, which CLAUDE.md already allows the engine to choose. Note this
ordering in the README as a demo setting.

**Commands (DEMO_MODE only)**: organizer texts `crowd 12` to add 12 simulated members,
or the demo bar does it.

---

## 11. Demo bar

A thin bar at the very bottom, visible only when `DEMO_MODE=true`, hidden with the `H`
key so it is not on screen while judges watch.

| Button | Action |
|---|---|
| Seed | Create the demo trip with the join code from `DEMO_CODE` (default `BEACH7`). |
| Crowd +12 | Add 12 simulated members. |
| Start | Same as the organizer texting `start`. |
| Drop a driver | Make one simulated driver drop out, to show rebalancing on cue. |
| Reset | Wipe state for the next judge. Ask for confirmation. |
| Replay | Section 14, only if built. |

Keyboard: `S` seed, `C` crowd, `G` start, `D` drop, `R` reset, `H` hide bar. A reset
between judges must take under 3 seconds and leave the page on the join screen.

---

## 12. Privacy rules for the page (non-negotiable)

1. No phone numbers anywhere: not in the DOM, not in the JSON, not in `console.log`.
2. No member message text anywhere. Topics and outcomes only.
3. No individual budget values anywhere, including hidden attributes and the debug JSON.
4. Padlock order is shuffled every render (section 7).
5. `groupCap` is null unless at least 2 going members answered.
6. The explainability drawer shows example data, never live conversation text.
7. Add a test: build a trip with known phones, budgets, and message texts, call
   `toDashboardView`, `JSON.stringify` it, and assert none of those strings appear.
   (A budget of `40` could collide with other numbers, so use distinctive test values
   such as `4173`.)
8. `/api/demo/*` returns 404 when `DEMO_MODE` is not true, and the server listens on
   `127.0.0.1` only.

---

## 13. Visual design

The hackathon theme is Frutiger Aero: glossy, optimistic, sky and water and green. Use
it with restraint; legibility from 1.5 meters comes first.

```css
:root {
  --sky-1: #d9f1ff;  --sky-2: #8fd0f5;  --sky-3: #2f9be0;
  --leaf:  #4fbf6b;  --leaf-deep: #23884a;
  --sun:   #ffb84d;  /* amber, for "short" and warnings */
  --ink:   #0f2a3d;  --ink-soft: #456377;
  --glass: rgba(255,255,255,0.62);  --glass-edge: rgba(255,255,255,0.9);
  --radius: 18px;
}
```
- **Background**: a vertical sky gradient (`--sky-1` to `--sky-2`), with 6-8 large soft
  translucent bubbles drifting slowly upward (CSS only, 30-60s loops, low opacity).
- **Cards**: glass panels (`--glass`, `backdrop-filter: blur(12px)`, 1px `--glass-edge`
  border, soft shadow) with a subtle glossy highlight across the top third.
- **The agent orb**: a glossy sphere, radial gradient from white highlight to `--sky-3`.
- **Type**: system font stack (`system-ui, -apple-system, "Segoe UI", sans-serif`). Stat
  numerals 64px bold; labels 15px; node names 14px; nothing on screen below 13px.
  Numerals use `font-variant-numeric: tabular-nums` so counters don't jitter.
- **Contrast**: all text is `--ink` on glass; check that it reads in a bright room.
  Provide a `?dark=1` variant only if time remains.
- **Buttons and chips**: pill-shaped, slight gloss, no heavy borders.
- All visuals are CSS and inline SVG. No image files, no icon font, no web fonts.

---

## 14. Build order (stop where the clock says)

Commit and push after every tier. Each tier leaves a demo-ready page.

**Tier 1 — must have (about 75 minutes)**
1. `toDashboardView` with the privacy test (section 12, rule 7) passing.
2. `/events` with `state` and `pulse`.
3. The page: header, the switchboard ring with moods and name labels, pulses out and in.
4. Needs cards with progress and chain chips.
5. The four stats, including the big `0`.
6. Feed ticker.

**Tier 2 — the wow (about 60 minutes)**
7. The hop arc and the "not bothered" halo.
8. Budget padlocks.
9. Crowd mode with labeled simulated members, and the demo bar.
10. Cars card.

**Tier 3 — polish (about 45 minutes, only if Tier 2 is committed by 3:00 AM)**
11. Frutiger Aero styling pass and the finalize celebration.
12. QR join (only after the real-phone check passes).
13. Personal plan cards.
14. "Why it said that" drawer.

**Tier 4 — only if everything else is done and rehearsed**
15. Carpool impact line.
16. Replay: record every `state` snapshot with a timestamp in memory; a scrubber plays
    the trip back at 8x. Useful for the submission video.

If a tier is half finished at its time limit, revert the unfinished part and keep the
last committed tier. A complete Tier 1 beats a broken Tier 3.

---

## 15. Acceptance checks

Run these before calling the dashboard done. Use crowd mode so no phones are needed.

1. Seed, add 12 simulated members, start. All 12 nodes appear, labeled `sim`, and lines
   pulse as questions go out.
2. The seats chain visibly hops between at least two nodes and stops when filled.
3. At least one going member ends as "not asked", and the "people not bothered" number
   is greater than 0 and equals the sum shown in the needs cards.
4. Budget shows `n of m answered`, no individual amounts, and the group number appears
   only after 2 answers.
5. View source and the `/api/state` JSON: no phone number, no message text, no
   individual budget.
6. Drop a driver: their node fades, the chain restarts, cars update.
7. Reset returns to the join screen in under 3 seconds; a second full run works.
8. Disconnect Wi-Fi: the page still loads and updates from localhost in crowd mode.
9. At 1280x720 nothing scrolls and no labels overlap with 15 members.
10. With a real phone joined alongside the crowd, the real member's node has a solid
    outline and the header reads `12 simulated · 1 real`.

---

## 16. How the page is used in the demo

1. Page is on the join screen. Presenter gives the one-line pitch.
2. Judge texts the join code (or scans the QR if it was verified). Their node appears.
3. Presenter presses `C` then `G`: 12 labeled simulated members join and the board
   lights up with parallel private conversations. Presenter says they are simulated.
4. The seats question hops through two simulated members who can't drive and reaches the
   judge's phone. The judge answers on their phone; the board shows seats filled and the
   "not bothered" halo on everyone else.
5. Presenter points at the big `0` and the padlocks: no group messages, no budgets shown.
6. Presenter presses `D`: a driver drops and the board rebalances.

Record a clean run of this for the 2-minute video.

---

## 17. What to tell the team when done

Report in plain language: which tier was reached, which acceptance checks passed and how
each was verified, anything skipped, and the exact keys to press during the demo. If
something was only tested in crowd mode and not with real phones, say so.

