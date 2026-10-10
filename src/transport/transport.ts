// The only thing the engine knows about messaging: send one text to one phone.
import type { Phone } from "../types.js";

export interface Transport {
  send(phone: Phone, text: string): Promise<void>;
}
