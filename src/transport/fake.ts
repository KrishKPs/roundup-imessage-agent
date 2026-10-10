// In-memory transport for tests and the simulator. Records every message instead of sending it.
import type { Phone } from "../types.js";
import type { Transport } from "./transport.js";

export interface SentMessage {
  phone: Phone;
  text: string;
}

export class FakeTransport implements Transport {
  sent: SentMessage[] = [];
  onSend?: (m: SentMessage) => void;

  async send(phone: Phone, text: string): Promise<void> {
    const m = { phone, text };
    this.sent.push(m);
    this.onSend?.(m);
  }

  to(phone: Phone): string[] {
    return this.sent.filter((m) => m.phone === phone).map((m) => m.text);
  }

  clear(): void {
    this.sent = [];
  }
}
