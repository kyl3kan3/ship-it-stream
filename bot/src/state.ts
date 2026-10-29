import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
export interface Idea {
  id: string;
  text: string;
  user: string;
  type: string;
  created: number;
}
export interface Round {
  candidates: Idea[];
  ballots: Record<string, number>;
  endsAt: number;
}
export interface Job {
  id: string;
  idea: Idea;
  branch: string;
  base?: string;
  head?: string;
  phase: "coding" | "review" | "approved" | "rejected" | "failed";
  diff?: { files: string[]; added: number; removed: number };
  pr?: string;
  preview?: string;
  error?: string;
}
export interface State {
  queue: Idea[];
  round?: Round;
  job?: Job;
  events: { at: number; text: string }[];
}
export class Store extends EventEmitter {
  data: State;
  constructor(readonly path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.data = { queue: [], events: [] };
    }
    if (this.data.job?.phase === "coding") {
      this.data.job.phase = "failed";
      this.data.job.error = "Interrupted; operator must inspect sandbox";
    }
  }
  save() {
    writeFileSync(this.path + ".tmp", JSON.stringify(this.data, null, 2), {
      mode: 0o600,
    });
    renameSync(this.path + ".tmp", this.path);
    this.emit("change", this.data);
  }
  event(text: string) {
    this.data.events.push({ at: Date.now(), text: text.slice(0, 500) });
    this.data.events = this.data.events.slice(-80);
    this.save();
  }
}
