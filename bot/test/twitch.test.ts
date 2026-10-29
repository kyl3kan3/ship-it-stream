import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSub } from "../src/twitch/eventsub.js";
import { Auth, REDIRECT, SCOPES } from "../src/twitch/auth.js";
import { sendChat } from "../src/twitch/chat.js";
import type { ChatMessage } from "../src/commands.js";
test("EventSub fixtures: welcome subscribe, notification, dedup, keepalive, reconnect, revocation", async (t) => {
  const fixtures = JSON.parse(
    readFileSync("bot/test/fixtures/eventsub.json", "utf8"),
  );
  const requests: any[] = [];
  const auth = {
    helix: async (path: string, init: any) => {
      requests.push({ path, body: JSON.parse(init.body) });
      return new Response("{}", { status: 202 });
    },
  } as unknown as Auth;
  const source = new EventSub(auth, "broadcaster", "bot");
  t.after(() => source.stop());
  const messages: ChatMessage[] = [];
  source.callback = (m) => messages.push(m);
  const connections: any[] = [];
  source.connect = (url, migration) => {
    connections.push({ url, migration });
  };
  await source.handle(fixtures[0]);
  assert.equal(requests[0].body.transport.session_id, "session-fixture");
  assert.deepEqual(requests[0].body.condition, {
    broadcaster_user_id: "broadcaster",
    user_id: "bot",
  });
  await source.handle(fixtures[0], true);
  assert.equal(requests.length, 1);
  await source.handle(fixtures[1]);
  await source.handle(fixtures[1]);
  const self = structuredClone(fixtures[1]);
  self.metadata.message_id = "bot-message";
  self.payload.event.chatter_user_id = "bot";
  await source.handle(self);
  const otherChannel = structuredClone(fixtures[1]);
  otherChannel.metadata.message_id = "other-channel";
  otherChannel.payload.event.broadcaster_user_id = "other";
  await source.handle(otherChannel);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].badges[0], "moderator");
  assert.equal(messages[0].text, "!ship Add a card");
  await source.handle(fixtures[2]);
  assert.ok(source.watchdog);
  await source.handle(fixtures[3]);
  assert.equal(connections[0].migration, true);
  await assert.rejects(
    () =>
      source.handle({
        metadata: { message_type: "session_reconnect" },
        payload: { session: { reconnect_url: "wss://evil.invalid/ws" } },
      }),
    /Invalid reconnect/,
  );
  await source.handle(fixtures[4]);
  assert.equal(source.stopped, true);
});
test("OAuth exchange, private persistence, expiry refresh, validation and Helix retry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ship-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = {
    id: process.env.TWITCH_CLIENT_ID,
    secret: process.env.TWITCH_CLIENT_SECRET,
    bot: process.env.TWITCH_BOT_ID,
  };
  process.env.TWITCH_CLIENT_ID = "fixture-client";
  process.env.TWITCH_CLIENT_SECRET = "fixture-secret";
  delete process.env.TWITCH_BOT_ID;
  t.after(() => {
    for (const [key, value] of [
      ["TWITCH_CLIENT_ID", old.id],
      ["TWITCH_CLIENT_SECRET", old.secret],
      ["TWITCH_BOT_ID", old.bot],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });
  let grants = 0,
    helix = 0;
  const request = (async (url: any, init: any) => {
    if (String(url).endsWith("/token")) {
      grants++;
      const params = init.body as URLSearchParams;
      assert.equal(params.get("client_secret"), "fixture-secret");
      if (grants === 1) assert.equal(params.get("redirect_uri"), REDIRECT);
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: grants === 1 ? 1 : 3600,
      });
    }
    if (String(url).endsWith("/validate"))
      return Response.json({
        client_id: "fixture-client",
        user_id: "bot",
        scopes: SCOPES,
      });
    helix++;
    return helix === 1
      ? new Response("", { status: 401 })
      : Response.json({ data: [{ is_sent: true }] });
  }) as typeof fetch;
  const auth = new Auth(dir, request);
  const url = new URL(auth.authorize("state"));
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  await auth.exchange("fixture-code");
  assert.equal(grants, 2);
  assert.ok(
    JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")).refresh_token,
  );
  await sendChat(auth, "channel", "bot", "hi");
  assert.equal(grants, 3);
  assert.equal(helix, 2);
});
