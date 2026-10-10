// The invite the organizer pastes in their group chat carries a tap-to-join link when the agent number is known.
import { describe, expect, it } from "vitest";
import { template } from "../src/llm/phrase.js";

describe("invite", () => {
  it("includes a prefilled sms link and the plain code", () => {
    const text = template({ kind: "invite_line", trip: "Beach day", code: "BEACH7", organizer: "Priya", agentNumber: "+15550001111" });
    expect(text).toContain("sms:+15550001111&body=join%20BEACH7");
    expect(text).toContain('"join BEACH7"');
    expect(text).toMatch(/AI/);
  });
  it("falls back to the code alone without an agent number", () => {
    const text = template({ kind: "invite_line", trip: "Beach day", code: "BEACH7", organizer: "Priya", agentNumber: null });
    expect(text).toContain('"join BEACH7"');
    expect(text).not.toContain("sms:");
  });
});
