// Real iMessage transport through Photon's Spectrum (cloud provider).
// Receives every inbound DM and hands it to the engine; sends replies into the same DM.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Phone } from "../types.js";
import { maskPhone, normalizePhone } from "../util.js";
import type { Transport } from "./transport.js";
import { UserRegistry } from "./registry.js";

type App = Awaited<ReturnType<typeof Spectrum>>;
type SpaceLike = { send: (text: string) => Promise<unknown>; responding: (fn: () => Promise<void>) => Promise<unknown> };

export class SpectrumTransport implements Transport {
  /** DM spaces we have seen, by phone. Only people who texted us first are ever in here (spec 10.3). */
  private spaces = new Map<Phone, SpaceLike>();
  private constructor(private app: App, private registry: UserRegistry) {}

  static async connect(projectId: string, projectSecret: string): Promise<SpectrumTransport> {
    const app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
      options: { logLevel: process.env.SPECTRUM_LOG_LEVEL === "debug" ? "debug" : "info" },
    });
    const registry = new UserRegistry(projectId);
    await registry.load();
    return new SpectrumTransport(app, registry);
  }

  /** Loop over inbound messages forever. Handlers run inside the typing indicator. */
  async listen(
    onText: (phone: Phone, text: string) => Promise<void>,
    onContacts: (phone: Phone, people: { name: string | null; phone: string }[]) => Promise<void>,
  ): Promise<void> {
    let loggedSender = false;
    for await (const [space, message] of this.app.messages) {
      try {
        if (message.platform !== "imessage") continue;
        const im = imessage(space);
        if (im.type !== "dm") continue; // MVP is DM-only (shared pool has no groups)
        const kind = message.content.type;
        if (kind !== "text" && kind !== "contact") continue;
        const sender = imessage(message).sender;
        const raw = sender?.address ?? message.sender?.id;
        if (!loggedSender) {
          // Milestone 1 check: confirm which field holds the E.164 number.
          console.log("[spectrum] first inbound sender fields:", {
            "message.sender.id": message.sender?.id ? maskPhone(String(message.sender.id)) : undefined,
            "imessage(message).sender.address": sender?.address ? maskPhone(sender.address) : undefined,
            service: sender?.service,
          });
          loggedSender = true;
        }
        if (!raw) continue;
        const phone = normalizePhone(String(raw));
        this.spaces.set(phone, space as unknown as SpaceLike);
        if (message.content.type === "contact") {
          const people = contactPeople(message.content);
          console.log(`[in]  ${maskPhone(phone)}: contact card with ${people.length} number(s)`);
          await space.responding(async () => {
            await onContacts(phone, people);
          });
          continue;
        }
        const text = message.content.text;
        console.log(`[in]  ${maskPhone(phone)}: ${text.length} chars`);
        await space.responding(async () => {
          await onText(phone, text);
        });
      } catch (err) {
        console.error("[spectrum] error handling inbound message:", err);
      }
    }
  }

  async send(phone: Phone, text: string): Promise<void> {
    await this.registry.ensure(phone); // shared pool only messages registered users
    let space = this.spaces.get(phone);
    if (!space) {
      // After a restart we may not have the space cached; reopen the existing DM.
      const im = imessage(this.app);
      const user = await im.user(phone);
      space = (await im.space.create(user)) as unknown as SpaceLike;
      this.spaces.set(phone, space);
    }
    await space.send(text);
    console.log(`[out] ${maskPhone(phone)}: ${text}`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

/** Pull names and phone numbers out of a shared contact card. Each card is one person (first mobile number). */
function contactPeople(content: unknown): { name: string | null; phone: string }[] {
  const c = content as {
    name?: { first?: string; formatted?: string };
    phones?: { value?: string; type?: string }[];
  };
  const phones = (c.phones ?? []).filter((p) => p.value);
  const best = phones.find((p) => /mobile|cell|iphone/i.test(p.type ?? "")) ?? phones[0];
  if (!best?.value) return [];
  const first = (c.name?.first || c.name?.formatted?.split(/\s+/)[0] || "").trim();
  return [{ name: first || null, phone: best.value }];
}
