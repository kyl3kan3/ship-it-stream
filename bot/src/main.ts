import { resolve } from "node:path";
import { Store } from "./state.js";
import { Runner } from "./runner.js";
import { Votes } from "./votes.js";
import { Commands } from "./commands.js";
import { Sim } from "./sim.js";
import { server } from "./server.js";
import { Auth } from "./twitch/auth.js";
import { EventSub } from "./twitch/eventsub.js";
import { sendChat, type ChatSource } from "./twitch/chat.js";
function positiveInt(
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error("Invalid numeric configuration");
  return n;
}
async function main() {
  const simMode = process.argv.includes("--sim");
  const store = new Store(resolve(".data/state.json"));
  const runner = new Runner(store, {
    repo: process.env.SANDBOX_REPO || "kyl3kan3/ship-it-sandbox",
    dir: resolve(".data/sandbox"),
    codex: process.env.CODEX_BIN || "codex",
    dryRun: process.env.DRY_RUN === "1",
    maxFiles: positiveInt("MAX_DIFF_FILES", 8),
    maxLines: positiveInt("MAX_DIFF_LINES", 400),
  });
  const votes = new Votes(
    store,
    positiveInt("VOTE_DURATION_MS", 180000, 2147483647),
    positiveInt("VOTE_CANDIDATES", 5, 100),
    (winner) => {
      if (winner)
        void runner
          .build(winner)
          .catch(() => store.event("Runner unavailable"));
    },
  );
  const commands = new Commands(store, votes, runner);
  let source: ChatSource;
  let reply: (text: string) => Promise<void>;
  if (simMode) {
    source = new Sim();
    reply = async (text) => {
      console.log(text);
    };
  } else {
    const auth = new Auth();
    const identity = await auth.validate();
    const bot = process.env.TWITCH_BOT_ID || identity.user_id;
    const broadcaster = process.env.TWITCH_BROADCASTER_ID;
    if (!broadcaster) throw new Error("Broadcaster ID required");
    source = new EventSub(auth, broadcaster, bot, (text) => store.event(text));
    reply = (text) => sendChat(auth, broadcaster, bot, text);
    const timer = setInterval(
      () =>
        void auth.validate().catch(() => {
          store.event("Twitch validation failed");
          source.stop();
        }),
      3600000,
    );
    timer.unref();
  }
  await source.start((m) => {
    void commands
      .handle(m)
      .then(async (text) => {
        if (text) await reply(text);
      })
      .catch(() => store.event("Chat command or reply failed"));
  });
  votes.schedule();
  const http = server(store, source instanceof Sim ? source : undefined);
  http.listen(positiveInt("PORT", 8787, 65535), "127.0.0.1", () =>
    console.log(
      "Ship-It Stream: http://127.0.0.1:" +
        (http.address() as any).port +
        "/overlay",
    ),
  );
  const stop = () => {
    source.stop();
    votes.stop();
    http.close();
    http.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(() => {
  console.error("Startup failed. Check local configuration and authorization.");
  process.exitCode = 1;
});
