import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Store } from "./state.js";
import { Sim } from "./sim.js";
export function server(store: Store, sim?: Sim) {
  const clients = new Set<import("node:http").ServerResponse>();
  const broadcast = () => {
    const frame = `data: ${JSON.stringify(store.data)}\n\n`;
    for (const res of clients) {
      if (res.writableLength > 256000) {
        res.destroy();
        clients.delete(res);
      } else res.write(frame);
    }
  };
  store.on("change", broadcast);
  const http = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/state") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(store.data));
      return;
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(store.data)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && (req.url === "/overlay" || req.url === "/")) {
      try {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          await readFile(
            new URL("../../overlay/index.html", import.meta.url),
            "utf8",
          ),
        );
      } catch {
        res.writeHead(500);
        res.end("Overlay unavailable");
      }
      return;
    }
    if (req.method === "POST" && req.url === "/sim/chat" && sim) {
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = "";
      try {
        for await (const b of req) {
          body += b;
          if (body.length > 4096) {
            res.writeHead(413);
            res.end();
            return;
          }
        }
        sim.post(JSON.parse(body));
        res.writeHead(202);
        res.end("Accepted");
      } catch {
        res.writeHead(400);
        res.end("Invalid chat message");
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  http.on("close", () => {
    clearInterval(heartbeat);
    store.off("change", broadcast);
    for (const res of clients) res.end();
  });
  return http;
}
