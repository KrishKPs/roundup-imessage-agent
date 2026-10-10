// Small helpers: phone normalization, masking, ids, names.
import type { Phone } from "./types.js";

/** Normalize a phone to E.164. Emails (iMessage can use them) are lowercased and kept as-is. */
export function normalizePhone(raw: string): Phone {
  const s = raw.trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/[^\d]/g, "");
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** "+19195550123" -> "+1•••••0123". Used in logs and on the dashboard. */
export function maskPhone(phone: Phone): string {
  if (phone.includes("@")) return `${phone[0]}•••@${phone.split("@")[1]}`;
  return `${phone.slice(0, 2)}•••••${phone.slice(-4)}`;
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Pull a first name out of replies like "Sam", "i'm sam", "it's Sam Lee". */
export function parseName(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^(hi|hey|hello)[,!.\s]+/i, "")
    .replace(/^(i'?m|im|i am|it'?s|its|my name is|name'?s|this is|call me)\s+/i, "");
  const word = cleaned.split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "") ?? "";
  if (word.length < 1 || word.length > 20) return null;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Trim and hard-cap to 160 characters (voice rule). */
export function clip(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
