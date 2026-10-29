import { createServer } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../runner.js";
export const REDIRECT = "https://localhost:3000/auth/callback";
export const SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "user:bot",
  "channel:bot",
  "moderator:read:chatters",
];
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
export class Auth {
  private tokens?: Tokens;
  private refreshing?: Promise<void>;
  constructor(
    readonly dir = resolve(".data"),
    readonly request: typeof fetch = fetch,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private client() {
    const id = process.env.TWITCH_CLIENT_ID,
      secret = process.env.TWITCH_CLIENT_SECRET;
    if (!id || !secret)
      throw new Error("Twitch credentials missing from environment");
    return { id, secret };
  }
  private save(tokens: Tokens) {
    this.tokens = tokens;
    const path = resolve(this.dir, "tokens.json");
    writeFileSync(path + ".tmp", JSON.stringify(tokens), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  private async grant(params: Record<string, string>) {
    const { id, secret } = this.client();
    const r = await this.request("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        ...params,
      }),
    });
    if (!r.ok) throw new Error("Twitch token exchange failed");
    const t = (await r.json()) as any;
    if (!t.access_token || !t.refresh_token || !Number.isFinite(t.expires_in))
      throw new Error("Invalid token response");
    this.save({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
    });
  }
  async exchange(code: string) {
    await this.grant({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
    });
    await this.validate();
  }
  async token() {
    if (!this.tokens)
      this.tokens = JSON.parse(
        readFileSync(resolve(this.dir, "tokens.json"), "utf8"),
      );
    if (this.tokens!.expires_at < Date.now() + 60000) await this.refresh();
    return this.tokens!.access_token;
  }
  async refresh() {
    if (!this.refreshing)
      this.refreshing = this.grant({
        grant_type: "refresh_token",
        refresh_token: this.tokens!.refresh_token,
      }).finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }
  async validate() {
    let r = await this.request("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${await this.token()}` },
    });
    if (r.status === 401) {
      await this.refresh();
      r = await this.request("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${await this.token()}` },
      });
    }
    if (!r.ok) throw new Error("Twitch validation failed");
    const v = (await r.json()) as any;
    if (
      v.client_id !== this.client().id ||
      !SCOPES.every((s) => v.scopes?.includes(s)) ||
      (process.env.TWITCH_BOT_ID && v.user_id !== process.env.TWITCH_BOT_ID)
    )
      throw new Error("Token identity or scopes mismatch");
    return v as { user_id: string };
  }
  async helix(path: string, init: RequestInit = {}) {
    const call = async () =>
      this.request(`https://api.twitch.tv/helix${path}`, {
        ...init,
        headers: {
          ...init.headers,
          "Client-Id": this.client().id,
          Authorization: `Bearer ${await this.token()}`,
          "Content-Type": "application/json",
        },
      });
    let r = await call();
    if (r.status === 401) {
      await this.refresh();
      r = await call();
    }
    return r;
  }
  authorize(state: string) {
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.client().id,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
    }).toString();
    return url.href;
  }
}
export async function startAuth() {
  const auth = new Auth();
  let state = randomBytes(32).toString("hex");
  auth.authorize(state); // Fail early if env credentials are missing; never print this URL.
  const dir = auth.dir;
  const key = resolve(dir, "localhost.key"),
    cert = resolve(dir, "localhost.crt");
  if (!existsSync(key) || !existsSync(cert))
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "30",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ]);
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      const url = new URL(req.url ?? "/", "https://localhost:3000");
      if (url.pathname === "/auth") {
        res.writeHead(302, { Location: auth.authorize(state) });
        res.end();
        return;
      }
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const given = url.searchParams.get("state") ?? "";
      if (
        given.length !== state.length ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(state)) ||
        !url.searchParams.get("code")
      ) {
        res.writeHead(400);
        res.end("Invalid OAuth callback");
        return;
      }
      state = randomBytes(32).toString("hex");
      try {
        await auth.exchange(url.searchParams.get("code")!);
        res.end("Authorized. You can close this tab.");
      } catch {
        res.writeHead(502);
        res.end("Authorization failed. Try /auth again.");
      }
    },
  );
  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    server.listen(3000, "localhost", ok);
  });
  // The local authorize URL redirects in-browser so the client ID is never printed.
  console.log("Authorize Twitch: https://localhost:3000/auth");
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  startAuth().catch(() => {
    console.error(
      "OAuth server failed; check credentials and openssl availability",
    );
    process.exitCode = 1;
  });
