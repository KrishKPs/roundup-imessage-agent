// Shared-pool plans only message numbers registered as project Users ("Target not allowed" otherwise).
// This registers each new person automatically the first time we reply to them, using the Photon CLI
// (which holds the login token from `npx photon login`). Nobody has to add numbers in the dashboard.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Phone } from "../types.js";
import { maskPhone } from "../util.js";

const run = promisify(execFile);

export class UserRegistry {
  private known = new Set<string>();
  private lines = new Map<string, string>(); // person -> the pool line they text the bot at
  private inFlight = new Map<string, Promise<void>>();

  constructor(private projectId: string) {}

  private cli(args: string[]) {
    return run("npx", ["photon", "spectrum", "users", ...args, "--project", this.projectId, "--json"], {
      timeout: 15_000,
      env: { ...process.env, CI: "1" }, // non-interactive: never prompt
    });
  }

  /** Load the numbers already registered on the project. */
  async load(): Promise<void> {
    try {
      const { stdout } = await this.cli(["ls"]);
      const users = JSON.parse(stdout) as { phoneNumber?: string; email?: string; assignedPhoneNumber?: string }[];
      for (const u of users) {
        if (u.phoneNumber) this.known.add(u.phoneNumber);
        if (u.phoneNumber && u.assignedPhoneNumber) this.lines.set(u.phoneNumber, u.assignedPhoneNumber);
        if (u.email) this.known.add(u.email.toLowerCase());
      }
      console.log(`[registry] ${this.known.size} users already registered on the project`);
    } catch (err) {
      console.warn(`[registry] could not list users (run \`npx photon login\` once): ${shortErr(err)}`);
    }
  }

  /** Make sure `phone` is a registered user. Safe to call many times. Resolves true if we just registered them. */
  async ensure(phone: Phone): Promise<boolean> {
    if (this.known.has(phone)) return false;
    let p = this.inFlight.get(phone);
    if (!p) {
      p = this.add(phone).finally(() => this.inFlight.delete(phone));
      this.inFlight.set(phone, p);
    }
    await p;
    return true;
  }

  /** The bot number this person should text (shared pool gives each person their own). */
  lineFor(phone: Phone): string | undefined {
    return this.lines.get(phone);
  }

  private async add(phone: Phone): Promise<void> {
    const digits = phone.replace(/\D/g, "");
    try {
      const { stdout } = await this.cli([
        "add", "--phone", phone, "--first-name", "Roundup", "--last-name", `Guest ${digits.slice(-4)}`,
        "--email", `roundup.guest.${digits}@example.com`,
      ]);
      const line = (JSON.parse(stdout) as { assignedPhoneNumber?: string }).assignedPhoneNumber;
      if (line) this.lines.set(phone, line);
      console.log(`[registry] registered ${maskPhone(phone)}`);
    } catch (err) {
      const msg = shortErr(err);
      // Already registered is fine; anything else we log and still try to send.
      if (!/exist|already|duplicate/i.test(msg)) console.warn(`[registry] could not register ${maskPhone(phone)}: ${msg}`);
      else await this.load(); // registered earlier: refresh so we know their line
    }
    this.known.add(phone);
  }
}

function shortErr(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(err)).trim().split("\n").slice(-2).join(" ").slice(0, 200);
}
