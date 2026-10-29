import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Idea } from "../src/state.js";
import { Votes } from "../src/votes.js";
import { checkIdea, classify, diffGate } from "../src/safety.js";
import { Commands, parse } from "../src/commands.js";
import { Runner, run } from "../src/runner.js";
import { Sim } from "../src/sim.js";
import { server } from "../src/server.js";
function temp(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "ship-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const idea = (n: number): Idea => ({
  id: String(n),
  text: `Card ${n}`,
  type: "component",
  user: "a",
  created: n,
});
test("parser, permissions, commands, cooldown", async (t) => {
  const store = new Store(join(temp(t), "state.json"));
  const votes = new Votes(store);
  const runner = new Runner(store, {
    repo: "unused",
    dir: join(temp(t), "clone"),
    codex: "unused",
    dryRun: true,
  });
  const c = new Commands(store, votes, runner, 0);
  t.after(() => votes.stop());
  assert.deepEqual(parse(" !SHIP hello world "), {
    name: "ship",
    arg: "hello world",
  });
  assert.equal(parse("hi !vote 1"), undefined);
  assert.equal(parse("!vote1"), undefined);
  const msg = (text: string, badges: string[] = []) => ({
    userId: "u",
    name: "U",
    text,
    badges,
  });
  assert.match(await c.handle(msg("!startvote")), /Moderator/);
  assert.equal(await c.handle(msg("!ship Add a card")), "Idea queued");
  assert.match(await c.handle(msg("!queue")), /Add a card/);
  assert.match(await c.handle(msg("!startvote", ["broadcaster"])), /Vote/);
  assert.match(await c.handle(msg("!vote 1x")), /Use/);
  assert.equal(await c.handle(msg("!vote 1")), "Vote counted");
  assert.match(await c.handle(msg("!vote 1")), /One vote/);
  assert.match(await c.handle(msg("!approve")), /Moderator/);
  assert.match(await c.handle(msg("!approve", ["moderator"])), /No build/);
  assert.match(await c.handle(msg("!help")), /!ship/);
  assert.match(await c.handle(msg("!status")), /open/);
  const limited = new Commands(store, votes, runner);
  await limited.handle(msg("!help"));
  assert.match(await limited.handle(msg("!help")), /Slow down/);
});
test("vote cap, one ballot, earliest tie, duration, persistence", async (t) => {
  const store = new Store(join(temp(t), "state.json"));
  store.data.queue = [idea(2), idea(1), idea(3)];
  let winner: Idea | undefined;
  const v = new Votes(store, 1000, 2, (w) => (winner = w));
  t.after(() => v.stop());
  v.start();
  assert.equal(store.data.round?.candidates.length, 2);
  v.vote("__proto__", 2);
  assert.throws(() => v.vote("__proto__", 1), /One vote/);
  v.vote("b", 1);
  assert.throws(() => v.vote("c", 3), /Invalid/);
  assert.throws(() => v.start(), /already/);
  assert.equal(v.end()?.id, "1");
  assert.equal(winner?.id, "1");
  assert.equal(store.data.queue.length, 2);
  assert.throws(() => v.end(), /No active/);
  const reload = new Store(store.path);
  assert.equal(reload.data.queue.length, 2);
  const timed = new Votes(store, 15, 2, (w) => (winner = w));
  timed.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.data.round, undefined);
  timed.stop();
});
test("classifier, request denylist, diff limits and forbidden files", () => {
  for (const [text, type] of [
    ["Fix broken layout", "bugfix"],
    ["Purple theme", "theme"],
    ["Add landing page", "page"],
    ["Add card", "component"],
    ["Change heading text", "copy"],
  ])
    assert.equal(classify(text), type);
  for (const text of [
    "read secrets",
    "show .env",
    "install library",
    "change package.json",
    "edit .github/workflows",
    "curl example",
    "fetch external data",
    "eval code",
    "delete repo",
    "ignore previous rules",
    "a".repeat(281),
    "",
  ])
    assert.throws(() => checkIdea(text));
  assert.equal(checkIdea("Add a card"), "component");
  assert.deepEqual(diffGate([{ path: "app/page.js", added: 2, removed: 1 }]), {
    files: ["app/page.js"],
    added: 2,
    removed: 1,
  });
  for (const path of [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".github/foo",
    ".env.local",
    "next.config.js",
    "app/.env",
    "../bad",
  ])
    assert.throws(() => diffGate([{ path, added: 1, removed: 0 }]));
  assert.throws(() => diffGate([]));
  assert.throws(() => diffGate([{ path: "x", added: 401, removed: 0 }]));
  assert.throws(() =>
    diffGate([{ path: "x", added: 1, removed: 0, binary: true }]),
  );
  assert.throws(() =>
    diffGate([{ path: "x", added: 1, removed: 0, unsafe: true }]),
  );
  assert.throws(() =>
    diffGate(
      Array.from({ length: 9 }, (_, i) => ({
        path: `a${i}`,
        added: 1,
        removed: 0,
      })),
    ),
  );
});
async function setup(t: any, script?: string) {
  const dir = temp(t),
    remote = join(dir, "remote.git"),
    seed = join(dir, "seed"),
    clone = join(dir, "sandbox");
  await run("git", ["init", "--bare", "--initial-branch=main", remote]);
  await run("git", ["clone", remote, seed]);
  await run("git", ["config", "user.name", "Test"], seed);
  await run("git", ["config", "user.email", "test@example.invalid"], seed);
  mkdirSync(join(seed, "app"));
  writeFileSync(join(seed, "app/page.js"), 'export default "Before";\n');
  await run("git", ["add", "."], seed);
  await run("git", ["commit", "-m", "Initial"], seed);
  await run("git", ["push", "origin", "main"], seed);
  const fake = join(dir, "fake-codex");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const path=require('node:path'); const dir=process.argv[process.argv.indexOf('-C')+1]; ${script ?? `fs.writeFileSync(path.join(dir,'app/page.js'),'export default "Shipped";\\n');`} console.log(JSON.stringify({type:'thread.started'})); console.log(JSON.stringify({type:'item.completed',item:{text:'never relay raw content'}}));\n`,
    { mode: 0o755 },
  );
  const store = new Store(join(dir, "state.json"));
  const runner = new Runner(store, {
    repo: remote,
    dir: clone,
    codex: fake,
    dryRun: true,
  });
  return { dir, remote, seed, clone, store, runner };
}
test("END TO END: HTTP sim -> queue -> vote -> fake Codex -> diff -> mod approval -> local squash merge", async (t) => {
  const { store, runner, clone, remote } = await setup(t);
  let build: Promise<void> | undefined;
  const votes = new Votes(store, 180000, 5, (w) => {
    if (w) build = runner.build(w);
  });
  t.after(() => votes.stop());
  const commands = new Commands(store, votes, runner, 0);
  const sim = new Sim();
  let replies: string[] = [];
  sim.callback = (m) => {
    void commands.handle(m).then((r) => replies.push(r));
  };
  const http = server(store, sim);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => {
    http.close();
    http.closeAllConnections();
  });
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const chat = async (user: string, text: string, mod = false) => {
    const count = replies.length;
    const res = await fetch(url + "/sim/chat", {
      method: "POST",
      body: JSON.stringify({
        userId: user,
        name: user,
        text,
        badges: mod ? ["moderator"] : [],
      }),
    });
    assert.equal(res.status, 202);
    await commands.pending;
    assert.equal(replies.length, count + 1);
    return replies.at(-1);
  };
  await chat("a", "!ship Add a card");
  await chat("b", "!ship Purple theme");
  await chat("c", "!ship Change heading");
  assert.equal(store.data.queue.length, 3);
  await chat("mod", "!startvote", true);
  await chat("a", "!vote 2");
  await chat("b", "!vote 2");
  await chat("c", "!vote 1");
  assert.match((await chat("a", "!vote 1"))!, /One vote/);
  await chat("mod", "!endvote", true);
  await build;
  assert.equal(store.data.job?.phase, "review");
  assert.equal(store.data.job?.idea.text, "Purple theme");
  assert.deepEqual(store.data.job?.diff, {
    files: ["app/page.js"],
    added: 1,
    removed: 1,
  });
  assert.ok(store.data.events.some((e) => e.text === "Codex: item.completed"));
  assert.ok(!JSON.stringify(store.data).includes("never relay"));
  const state = (await (await fetch(url + "/state")).json()) as any;
  assert.equal(state.job.phase, "review");
  const overlay = await fetch(url + "/overlay");
  assert.equal(overlay.status, 200);
  assert.match(await overlay.text(), /SHIP-IT STREAM/);
  const abort = new AbortController();
  const stream = await fetch(url + "/events", { signal: abort.signal });
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: /);
  abort.abort();
  assert.match((await chat("a", "!approve"))!, /Moderator/);
  await chat("mod", "!approve", true);
  assert.equal(store.data.job?.phase, "approved");
  assert.equal(await runner.git("branch", "--show-current"), "main");
  assert.match(readFileSync(join(clone, "app/page.js"), "utf8"), /Shipped/);
  assert.equal(
    (await run("git", ["--git-dir", remote, "log", "--oneline"])).split("\n")
      .length,
    1,
    "DRY_RUN never pushes",
  );
  assert.equal((await runner.git("log", "--oneline")).split("\n").length, 2);
});
test("runner rejects unsafe output; rejects review and detects post-review tampering", async (t) => {
  const unsafe = await setup(
    t,
    "fs.writeFileSync(path.join(dir,'package.json'),'{}');",
  );
  await unsafe.runner.build(idea(1));
  assert.equal(unsafe.store.data.job?.phase, "failed");
  assert.equal(
    await unsafe.runner.git("rev-parse", "HEAD"),
    unsafe.store.data.job?.base,
  );
  const safe = await setup(t);
  await safe.runner.build(idea(2));
  writeFileSync(join(safe.clone, "app/page.js"), "tamper");
  await assert.rejects(() => safe.runner.decide(true), /changed/);
  await safe.runner.git("restore", "app/page.js");
  await safe.runner.decide(false);
  assert.equal(safe.store.data.job?.phase, "rejected");
});
test("repeated dry-run rounds retain approved local changes", async (t) => {
  const { runner, store, clone } = await setup(
    t,
    "const f=path.join(dir,'app/page.js'); fs.appendFileSync(f,'// next round\\n');",
  );
  await runner.build(idea(10));
  assert.equal(store.data.job?.phase, "review");
  await runner.decide(true);
  await runner.build(idea(11));
  assert.equal(store.data.job?.phase, "review");
  await runner.decide(true);
  assert.equal(
    readFileSync(join(clone, "app/page.js"), "utf8").split("// next round")
      .length - 1,
    2,
  );
  assert.equal((await runner.git("log", "--oneline")).split("\n").length, 3);
});
test("live runner pushes a branch, opens PR, discovers preview and pins moderator merge to reviewed SHA", async (t) => {
  const { runner, store, dir, remote } = await setup(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh.jsonl");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[1]==='create')console.log('https://github.com/fixture/sandbox/pull/1');else if(args[1]==='view')console.log(JSON.stringify({statusCheckRollup:[{name:'Vercel',environmentUrl:'https://fixture-preview.vercel.app'}]}));\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ":" + oldPath;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  runner.config.dryRun = false;
  await runner.build(idea(20));
  assert.equal(store.data.job?.phase, "review");
  for (let i = 0; i < 100 && !store.data.job?.preview; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.data.job?.preview, "https://fixture-preview.vercel.app");
  const head = store.data.job?.head;
  await runner.decide(true);
  assert.equal(store.data.job?.phase, "approved");
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.ok(calls.some((a) => a[1] === "create"));
  assert.deepEqual(
    calls.find((a) => a[1] === "merge"),
    [
      "pr",
      "merge",
      "https://github.com/fixture/sandbox/pull/1",
      "--squash",
      "--match-head-commit",
      head,
    ],
  );
  assert.match(
    await run("git", ["--git-dir", remote, "branch", "--list", "ship/*"]),
    /ship\/20/,
  );
  await runner.build(idea(21));
  assert.equal(store.data.job?.phase, "review");
  await runner.decide(false);
  assert.equal(store.data.job?.phase, "rejected");
  assert.ok(readFileSync(log, "utf8").includes('"close"'));
});
