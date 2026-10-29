import type { Auth } from "./auth.js";
import type { ChatMessage } from "../commands.js";
export interface ChatSource {
  start(onMessage: (message: ChatMessage) => void): Promise<void>;
  stop(): void;
}
export async function sendChat(
  auth: Auth,
  broadcaster: string,
  bot: string,
  message: string,
) {
  const res = await auth.helix("/chat/messages", {
    method: "POST",
    body: JSON.stringify({
      broadcaster_id: broadcaster,
      sender_id: bot,
      message: message.slice(0, 500),
    }),
  });
  if (!res.ok) throw new Error("Chat send failed");
  const result = (await res.json()) as any;
  if (result.data?.[0]?.is_sent === false)
    throw new Error("Chat message rejected");
}
