// Holds all app state in memory and saves it to data/state.json atomically (write temp file, then rename).
import fs from "node:fs";
import path from "node:path";
import type { State } from "./types.js";

export function emptyState(): State {
  return { trips: {}, phoneTrip: {} };
}

export class Store {
  state: State;

  /** `file` = null keeps everything in memory (tests). */
  constructor(private file: string | null) {
    this.state = file ? Store.load(file) : emptyState();
  }

  static load(file: string): State {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as State;
    } catch {
      return emptyState();
    }
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  reset(): void {
    this.state = emptyState();
    this.save();
  }
}
