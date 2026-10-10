// The only thing the engine knows about messaging: send one text to one phone.
import type { Phone } from "../types.js";

export interface Transport {
  send(phone: Phone, text: string): Promise<void>;
  /** The bot number this person texts, when the transport knows it (shared pool: one per person). */
  lineFor?(phone: Phone): string | undefined;
}
