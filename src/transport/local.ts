// iMessage through this Mac's own Messages app, via Spectrum's local provider (@spectrum-ts/imessage-local).
// Why: Photon's shared cloud lines refuse to text someone first ("Target not allowed"). The Mac's own iMessage
// account can, so the bot can invite friends directly, from one number, with no allowlist.
// Needs: macOS, Messages signed in (ideally to a separate Apple ID for the bot), and Full Disk Access
// for the terminal so it can read ~/Library/Messages/chat.db.
import { Spectrum } from "spectrum-ts";
import { localIMessage } from "@spectrum-ts/imessage-local";
import type { Phone } from "../types.js";
import { maskPhone, normalizePhone } from "../util.js";
import type { Transport } from "./transport.js";

type App = Awaited<ReturnType<typeof Spectrum>>;
type SpaceLike = { send: (text: string) => Promise<unknown>; responding: (fn: () => Promise<void>) => Promise<unknown> };
type People = { name: string | null; phone: string }[];

export class LocalTransport implements Transport {
  private spaces = new Map<Phone, SpaceLike>();
  private constructor(private app: App) {}

  static async connect(): Promise<LocalTransport> {
    const app = await Spectrum({ providers: [localIMessage.config()] });
    return new LocalTransport(app);
  }

  async listen(onText: (phone: Phone, text: string) => Promise<void>, onContacts: (phone: Phone, people: People) => Promise<void>): Promise<void> {
    for await (const [space, message] of this.app.messages) {
      try {
        if (message.platform !== "local_imessage") continue;
        if (localIMessage(space).type !== "dm") continue; // DM-only, same as cloud
        const kind = message.content.type;
        if (kind !== "text" && kind !== "contact") continue;
        const raw = localIMessage(message).sender?.address ?? message.sender?.id;
        if (!raw) continue;
        const phone = normalizePhone(String(raw));
        this.spaces.set(phone, space as unknown as SpaceLike);
        if (message.content.type === "contact") {
          const people = contactPeople(message.content);
          console.log(`[in]  ${maskPhone(phone)}: contact card with ${people.length} number(s)`);
          await onContacts(phone, people);
          continue;
        }
        const text = message.content.text;
        console.log(`[in]  ${maskPhone(phone)}: ${text.length} chars`);
        await onText(phone, text);
      } catch (err) {
        console.error("[local] error handling inbound message:", err);
      }
    }
  }

  /** Works for anyone, including people who never texted the bot: that's the point of local mode. */
  async send(phone: Phone, text: string): Promise<void> {
    let space = this.spaces.get(phone);
    if (!space) {
      const im = localIMessage(this.app);
      space = (await im.space.create(await im.user(phone))) as unknown as SpaceLike;
      this.spaces.set(phone, space);
    }
    await space.send(text);
    console.log(`[out] ${maskPhone(phone)}: ${text}`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

/** Same contact-card parsing as the cloud transport. */
function contactPeople(content: unknown): People {
  const c = content as { name?: { first?: string; formatted?: string }; phones?: { value?: string; type?: string }[] };
  const phones = (c.phones ?? []).filter((p) => p.value);
  const best = phones.find((p) => /mobile|cell|iphone/i.test(p.type ?? "")) ?? phones[0];
  if (!best?.value) return [];
  const first = (c.name?.first || c.name?.formatted?.split(/\s+/)[0] || "").trim();
  return [{ name: first || null, phone: best.value }];
}
