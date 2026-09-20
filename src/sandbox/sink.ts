import http from "node:http";
import { SINK_PORT } from "../scenarios/catalog.js";

/**
 * A tiny local HTTP server that plays the role of "some external service".
 * If the adversary sends anything here, that is exfiltration.
 */
export interface SinkHit {
  ts: number;
  method: string;
  url: string;
  body: string;
}

export interface Sink {
  port: number;
  hits: SinkHit[];
  close: () => Promise<void>;
}

export function startSink(port = SINK_PORT): Promise<Sink> {
  const hits: SinkHit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ ts: Date.now(), method: req.method ?? "?", url: req.url ?? "/", body: body.slice(0, 4000) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        hits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
