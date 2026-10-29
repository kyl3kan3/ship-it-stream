import { createInterface, type Interface } from "node:readline";
import type { ChatMessage } from "./commands.js";
import type { ChatSource } from "./twitch/chat.js";
export class Sim implements ChatSource {
  callback?: (m: ChatMessage) => void;
  input?: Interface;
  async start(onMessage: (m: ChatMessage) => void) {
    this.callback = onMessage;
    this.input = createInterface({ input: process.stdin });
    this.input.on("line", (line) => {
      try {
        this.post(JSON.parse(line));
      } catch {
        console.log(
          'Use JSON: {"userId":"alice","name":"Alice","text":"!help","badges":[]}',
        );
      }
    });
  }
  post(value: unknown) {
    const m = value as ChatMessage;
    if (
      !m ||
      typeof m.userId !== "string" ||
      !m.userId ||
      m.userId.length > 100 ||
      typeof m.text !== "string" ||
      m.text.length > 600 ||
      typeof m.name !== "string" ||
      m.name.length > 100 ||
      !Array.isArray(m.badges) ||
      !m.badges.every((b) => typeof b === "string")
    )
      throw new Error("Invalid chat message");
    this.callback?.(m);
  }
  stop() {
    this.input?.close();
  }
}
