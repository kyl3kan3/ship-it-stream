import { Store, type Idea } from "./state.js";
export interface PointsHook {
  enabled: boolean;
  onVote?(user: string, candidate: number): void;
}
export class Votes {
  timer?: NodeJS.Timeout;
  constructor(
    readonly store: Store,
    readonly duration = 180000,
    readonly topN = 5,
    readonly onEnd: (winner: Idea | undefined) => void = () => {},
    readonly points: PointsHook = { enabled: false },
  ) {}
  start() {
    if (this.store.data.round) throw new Error("Voting already open");
    if (["coding", "review"].includes(this.store.data.job?.phase ?? ""))
      throw new Error("Finish the current build first");
    const candidates = this.store.data.queue.slice(0, this.topN);
    if (!candidates.length) throw new Error("Queue is empty");
    this.store.data.round = {
      candidates,
      ballots: {},
      endsAt: Date.now() + this.duration,
    };
    this.store.event("Voting is open");
    this.schedule();
  }
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const round = this.store.data.round;
    if (round) {
      this.timer = setTimeout(
        () => this.end(),
        Math.max(0, round.endsAt - Date.now()),
      );
      this.timer.unref();
    }
  }
  vote(user: string, n: number) {
    const r = this.store.data.round;
    if (!r || Date.now() >= r.endsAt) throw new Error("Voting is closed");
    if (!Number.isInteger(n) || n < 1 || n > r.candidates.length)
      throw new Error("Invalid candidate");
    if (Object.hasOwn(r.ballots, user))
      throw new Error("One vote per user per round");
    Object.defineProperty(r.ballots, user, {
      value: n,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    this.store.save();
    if (this.points.enabled) this.points.onVote?.(user, n);
  }
  end() {
    const r = this.store.data.round;
    if (!r) throw new Error("No active vote");
    if (this.timer) clearTimeout(this.timer);
    const counts = r.candidates.map(
      (_, i) => Object.values(r.ballots).filter((n) => n === i + 1).length,
    );
    const best = Math.max(...counts);
    const winner = r.candidates
      .filter((_, i) => counts[i] === best)
      .sort((a, b) => a.created - b.created)[0];
    delete this.store.data.round;
    this.store.data.queue = this.store.data.queue.filter(
      (i) => i.id !== winner?.id,
    );
    this.store.event(`Winner: ${winner?.text}`);
    this.onEnd(winner);
    return winner;
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
