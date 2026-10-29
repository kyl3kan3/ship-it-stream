import { randomUUID } from "node:crypto";
import { Store } from "./state.js";
import { Votes } from "./votes.js";
import { Runner } from "./runner.js";
import { checkIdea } from "./safety.js";
export interface ChatMessage {
  userId: string;
  name: string;
  text: string;
  badges: string[];
}
export function parse(text: string) {
  const m =
    /^!(ship|queue|vote|approve|reject|status|help|startvote|endvote)(?:\s+(.*))?$/i.exec(
      text.trim(),
    );
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? "").trim() } : undefined;
}
export class Commands {
  limits = new Map<string, number>();
  pending: Promise<void> = Promise.resolve();
  constructor(
    readonly store: Store,
    readonly votes: Votes,
    readonly runner: Runner,
    readonly cooldown = 1500,
  ) {}
  handle(m: ChatMessage): Promise<string> {
    const work = this.pending.then(() => this.execute(m));
    this.pending = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  private async execute(m: ChatMessage) {
    const c = parse(m.text);
    if (!c) return "";
    const now = Date.now();
    if (now - (this.limits.get(m.userId) ?? 0) < this.cooldown)
      return "Slow down; try again shortly";
    this.limits.set(m.userId, now);
    if (this.limits.size > 10000)
      for (const [u, t] of this.limits)
        if (now - t > 60000) this.limits.delete(u);
    try {
      if (
        ["startvote", "endvote", "approve", "reject"].includes(c.name) &&
        !m.badges.some((b) => b === "moderator" || b === "broadcaster")
      )
        throw new Error("Moderator or broadcaster only");
      switch (c.name) {
        case "ship": {
          const type = checkIdea(c.arg);
          if (this.store.data.queue.length >= 100)
            throw new Error("Queue is full");
          this.store.data.queue.push({
            id: randomUUID(),
            text: c.arg,
            user: m.name,
            type,
            created: Date.now(),
          });
          this.store.event(`Queued: ${c.arg}`);
          return "Idea queued";
        }
        case "queue":
          return (
            this.store.data.queue
              .map((i, n) => `${n + 1}. ${i.text}`)
              .join(" | ")
              .slice(0, 450) || "Queue is empty"
          );
        case "startvote":
          this.votes.start();
          return "Vote with !vote N";
        case "vote":
          if (!/^\d+$/.test(c.arg)) throw new Error("Use !vote N");
          this.votes.vote(m.userId, Number(c.arg));
          return "Vote counted";
        case "endvote":
          this.votes.end();
          return "Vote ended; winner sent to Codex";
        case "approve":
          await this.runner.decide(true);
          return "Approved and merged";
        case "reject":
          await this.runner.decide(false);
          return "PR rejected";
        case "status":
          return `Build: ${this.store.data.job?.phase ?? "idle"} | Queue: ${this.store.data.queue.length} | Vote: ${this.store.data.round ? "open" : "closed"}`;
        default:
          return "!ship <idea> | !queue | !vote N | !status | !help | Mods: !startvote !endvote !approve !reject";
      }
    } catch (e) {
      return e instanceof Error ? e.message : "Command failed";
    }
  }
}
