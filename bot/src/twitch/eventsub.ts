import type { ChatSource } from "./chat.js";
import type { ChatMessage } from "../commands.js";
import type { Auth } from "./auth.js";
export class EventSub implements ChatSource {
  socket?: WebSocket;
  sockets = new Set<WebSocket>();
  watchdog?: NodeJS.Timeout;
  retry?: NodeJS.Timeout;
  stopped = false;
  callback?: (m: ChatMessage) => void;
  seen = new Set<string>();
  timeout = 15000;
  constructor(
    readonly auth: Auth,
    readonly broadcaster: string,
    readonly bot: string,
    readonly report: (text: string) => void = () => {},
  ) {}
  async start(callback: (m: ChatMessage) => void) {
    this.callback = callback;
    this.stopped = false;
    this.connect();
  }
  connect(url = "wss://eventsub.wss.twitch.tv/ws", migration = false) {
    if (this.stopped) return;
    const old = this.socket;
    const ws = new WebSocket(url);
    this.sockets.add(ws);
    this.socket = ws;
    const welcome = setTimeout(() => ws.close(), 15000);
    welcome.unref();
    ws.addEventListener("message", (e) => {
      void (async () => {
        try {
          const data = JSON.parse(String(e.data));
          if (data.metadata?.message_type === "session_welcome") {
            clearTimeout(welcome);
            if (migration) old?.close();
          }
          await this.handle(data, migration);
        } catch {
          this.report("EventSub message or subscription failed");
          ws.close();
        }
      })();
    });
    ws.addEventListener("error", () => ws.close());
    ws.addEventListener("close", () => {
      this.sockets.delete(ws);
      clearTimeout(welcome);
      if (this.socket !== ws || this.stopped) return;
      clearTimeout(this.watchdog);
      for (const other of this.sockets) other.close();
      this.sockets.clear();
      this.retry = setTimeout(() => this.connect(), 2000);
      this.retry.unref();
    });
  }
  touch() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.report("EventSub keepalive timeout");
      this.socket?.close();
    }, this.timeout);
    this.watchdog.unref();
  }
  async handle(data: any, migration = false) {
    const kind = data.metadata?.message_type;
    this.touch();
    if (kind === "session_welcome") {
      this.timeout =
        (data.payload.session.keepalive_timeout_seconds ?? 10) * 1000 + 2000;
      this.touch();
      if (!migration) {
        const res = await this.auth.helix("/eventsub/subscriptions", {
          method: "POST",
          body: JSON.stringify({
            type: "channel.chat.message",
            version: "1",
            condition: {
              broadcaster_user_id: this.broadcaster,
              user_id: this.bot,
            },
            transport: {
              method: "websocket",
              session_id: data.payload.session.id,
            },
          }),
        });
        if (!res.ok) throw new Error("Subscription failed");
      }
      this.report("Twitch chat connected");
    } else if (
      kind === "notification" &&
      data.payload.subscription.type === "channel.chat.message"
    ) {
      const id = data.metadata.message_id;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 2000)
        this.seen.delete(this.seen.values().next().value!);
      const e = data.payload.event;
      if (
        e.broadcaster_user_id !== this.broadcaster ||
        (e.chatter_user_id === this.bot && !String(e.message?.text ?? "").startsWith("!"))
      )
        return;
      this.callback?.({
        userId: e.chatter_user_id,
        name: e.chatter_user_name,
        text: e.message.text,
        badges: (e.badges ?? []).map((b: any) => b.set_id),
      });
    } else if (kind === "session_reconnect") {
      const url = new URL(data.payload.session.reconnect_url);
      if (url.protocol !== "wss:" || url.hostname !== "eventsub.wss.twitch.tv")
        throw new Error("Invalid reconnect URL");
      this.connect(url.href, true);
    } else if (kind === "revocation") {
      this.report("EventSub subscription revoked; reauthorize Twitch");
      this.stop();
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
  }
}
