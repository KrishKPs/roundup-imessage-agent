// Shared data types for the whole app (spec section 7, plus a few small additions noted inline).

export type Phone = string; // E.164, e.g. "+19195550123". Normalized on every inbound.

export interface Trip {
  id: string;
  code: string; // join code, e.g. "BEACH7"
  title: string;
  dateText: string | null;
  organizer: Phone;
  status: "collecting_members" | "coordinating" | "finalized";
  members: Record<Phone, Member>;
  needs: Need[];
  log: LogEvent[];
  createdAt: number;
  startedAt: number | null; // addition: when `start` was sent (drives the seats-chain timeout)
  poll?: Poll | null; // addition: the organizer's latest "ask everyone ..." question
}

/** "ask everyone does 10am saturday work?": asked 1:1, tallied, reported back to the organizer. */
export interface Poll {
  id: string;
  question: string;
  open?: boolean; // free-text answers ("which days are you free?") instead of yes/no/maybe
  askedAt: number;
  asked: Phone[];
  answers: Record<Phone, string>; // "yes"/"no"/"maybe", or their own words for open questions
  reported: boolean;
}

export interface Member {
  phone: Phone;
  name: string; // "" until they tell us
  rsvp: "unknown" | "yes" | "no" | "maybe";
  budgetCap: number | null; // PRIVATE. Never sent to anyone else. Never on the dashboard.
  canDrive: boolean | null;
  seats: number | null; // total seats including the driver
  bringing: string[];
  pendingAsk: Ask | null; // at most ONE open question per member
  askQueue: Ask[];
  unclearCount: number;
  optedOut: boolean;
  joinedAt: number;
  // additions:
  carHint: boolean; // mentioned a car unprompted -> moved to the front of the drive chain
  staleAsk: Ask | null; // last question we gave up on; a late answer is still applied
  sentSinceReply: number; // messages sent since their last reply (cap of 2 for questions)
  lastPlan: string | null; // last plan text we sent, so updates only go to people whose plan changed
  invited?: boolean; // added by the organizer (contact card or number) rather than joining by code
  heardFrom?: boolean; // they have texted us at least once
  viaLink?: boolean; // signed up on the website (trip link); we greet them when they first text in
}

export interface Need {
  id: string;
  kind: "seats" | "item";
  label: string;
  quantityNeeded: number;
  quantityFilled: number;
  candidates: Phone[];
  asked: Phone[];
  declined: Phone[];
  providers: Phone[];
  status: "open" | "filled" | "short";
  // additions:
  waitingOn: Phone | null; // whose answer the chain is waiting for (chains are sequential)
  shortNotified: number | null; // shortfall we last told the organizer about, to avoid repeats
}

export type AskTopic = "name" | "rsvp" | "budget" | "drive" | "seats" | "item" | "poll";

export interface Ask {
  id: string;
  topic: AskTopic; // "name" and "seats" are additions: name capture and the "how many seats?" follow-up
  needId: string | null;
  pollId?: string; // topic "poll": which organizer question this is
  askedAt: number; // 0 while still queued
  nudged: boolean;
}

export type LogKind =
  | "joined" | "asked" | "answered" | "need_filled" | "need_short"
  | "dropped" | "nudged" | "handoff" | "finalized";

export interface LogEvent {
  at: number;
  kind: LogKind;
  text: string; // dashboard-safe sentence. NO private data.
}

export interface ParsedReply {
  intent: "answer" | "drop" | "question" | "opt_out" | "other";
  rsvp: "yes" | "no" | "maybe" | null;
  canDrive: boolean | null;
  seats: number | null;
  budgetCap: number | null;
  itemYes: boolean | null;
  confidence: number;
}

export interface State {
  trips: Record<string, Trip>;
  phoneTrip: Record<Phone, string>; // which trip a phone is currently part of
  awaitingPlan?: Record<Phone, number>; // strangers we asked "what are you planning?"
  history?: Record<Phone, { from: "them" | "bot"; text: string; at: number }[]>; // last few texts per person, for the AI only
}

// A structured "say this" instruction. llm/phrase.ts turns it into one text.
export type MessageIntent =
  | { kind: "text"; text: string } // already final (plans, summaries); never rephrased
  | { kind: "ask_name_member"; trip: string; organizer: string }
  | { kind: "ask_name_organizer" }
  | { kind: "intro"; name: string; trip: string; organizer: string }
  | { kind: "trip_created"; name: string; trip: string; code: string; joinByLink: boolean }
  | { kind: "invite_line"; trip: string; code: string; organizer: string; agentNumber: string | null }
  | { kind: "ask_rsvp"; name: string; trip: string; date: string | null }
  | { kind: "ask_budget"; name: string }
  | { kind: "ask_drive"; name: string; trip: string }
  | { kind: "ask_seats"; name: string }
  | { kind: "ask_item"; name: string; item: string; trip: string }
  | { kind: "reask"; topic: AskTopic; item: string | null }
  | { kind: "nudge"; topic: AskTopic; item: string | null; name: string }
  | { kind: "ack"; topic: AskTopic; value: "yes" | "no" | "maybe" | "skip" | "done" }
  | { kind: "handoff_member"; organizer: string }
  | { kind: "handoff_organizer"; name: string; topic: AskTopic; item: string | null }
  | { kind: "question_answer"; trip: string; date: string | null; organizer: string; collecting: boolean; flagged: boolean }
  | { kind: "question_organizer"; name: string; note?: string | null; fyi?: boolean }
  | { kind: "drop_ack"; name: string }
  | { kind: "organizer_drop"; name: string }
  | { kind: "short_organizer"; label: string; missing: number; unit: string }
  | { kind: "stop_confirm" }
  | { kind: "unknown_code" }
  | { kind: "help" }
  | { kind: "already_member"; trip: string }
  | { kind: "waiting_for_start"; organizer: string }
  | { kind: "started_organizer"; count: number }
  | { kind: "needs_added"; items: string[] }
  | { kind: "not_organizer"; organizer: string }
  | { kind: "late_ack" }
  | { kind: "noted_car" }
  | { kind: "all_set" }
  | { kind: "invited"; name: string; trip: string; organizer: string; date: string | null; again?: boolean }
  | { kind: "people_added"; names: string[]; skipped: number; started: boolean }
  | { kind: "add_needs_trip" }
  | { kind: "ask_what_planning" }
  | { kind: "organizer_ready"; name: string; trip: string }
  | { kind: "ask_poll"; organizer: string; question: string; open: boolean }
  | { kind: "poll_ack"; organizer: string; question: string; answer: string } // thanks for answering, reacting to what they said
  | { kind: "status_report"; text: string } // the plain status line, reworded into a normal text
  | { kind: "poll_report"; question: string; open: boolean; answers: { name: string; answer: string }[]; silent: string[] }
  | { kind: "organizer_help" }
  | { kind: "pair"; first: MessageIntent; second: MessageIntent }; // a quick ack + the next message, sent as one text

export interface Outbound {
  phone: Phone;
  intent: MessageIntent;
}
