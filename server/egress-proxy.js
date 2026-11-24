// A forward proxy, local to one run, that every connection the browser makes goes through. It
// refuses loopback, private-network and other reserved addresses (unless the host is listed
// exactly in ALLOWED_TARGET_HOSTS), so a tested page cannot reach this server's own network or
// a cloud metadata endpoint, whatever its scripts, iframes, redirects or workers ask for. It
// resolves each host itself and connects to the address it checked, so DNS rebinding does not
// get past it.
//
// Requests a journey's setup fulfils with page.route (the STEM-Accessibility mock) never reach
// the network, so mocks still work.
//
// A run may move at most MAX_BYTES through the proxy, both directions together: then every open
// connection is closed and new ones are refused, so a page cannot use the server to move data
// for the whole run.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { resolveEgress } from "./hosts.js";

const MAX_BLOCKED = 50;
export const MAX_BYTES = 100 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);
const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));

/**
 * Start the proxy on 127.0.0.1. Returns `{ server: "http://127.0.0.1:<port>", blocked, close() }`,
 * where `blocked` lists the refused connections as "host:port (reason)".
 *
 * `connectTo` and `requestTo` (net.connect and http.request) are for the tests, which check that
 * they get the address that was checked, never the host name.
 *
 * @param {{ rules?: any[], lookup?: (host: string) => Promise<string[]>, idleMs?: number, maxBytes?: number, connectTo?: typeof connect, requestTo?: typeof httpRequest }} [options]
 */
export async function startEgressProxy({ rules, lookup, idleMs = 60000, maxBytes = MAX_BYTES, connectTo = connect, requestTo = httpRequest } = {}) {
  // Distinct refusals only, and at most MAX_BLOCKED of them: a page can make requests in a loop.
  const blocked = [];
  const seen = new Set();
  const decide = async (host, port) => {
    const decision = await resolveEgress(host, port, rules, lookup);
    const entry = `${host}:${port} (${decision.reason})`;
    if (!decision.ok && blocked.length < MAX_BLOCKED && !seen.has(entry)) {
      seen.add(entry);
      blocked.push(entry);
    }
    return decision;
  };

  // The bytes this run has moved (`tally`), and what is still open on either side (`hold`), so
  // that at the limit everything is closed at once, the browser's side first.
  let moved = 0;
  let full = false;
  const open = new Set();
  /** @param {{ destroy: () => unknown, on: (event: "close", listener: () => void) => unknown }} thing */
  const hold = (thing) => {
    open.add(thing);
    thing.on("close", () => open.delete(thing));
  };
  /** @param {import("node:stream").Readable} stream */
  const tally = (stream) =>
    stream.on("data", (chunk) => {
      moved += chunk.length;
      if (full || moved <= maxBytes) return;
      full = true;
      blocked.push(`all connections (byte limit: the run moved its ${Math.round(maxBytes / 1024 / 1024)} MB through the network guard)`);
      for (const each of open) each.destroy();
    });

  const server = createServer(async (req, res) => {
    // A plain-http request through a proxy carries an absolute URL.
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const decision = full ? { ok: false } : await decide(url.hostname, port);
    if (!decision.ok || full) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Blocked by the screen-reader-journeys network guard.\n");
      return;
    }
    hold(res);
    tally(req);
    const upstream = requestTo(
      {
        host: decision.address ?? url.hostname.replace(/^\[|\]$/g, ""),
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...strip(req.headers), host: url.host },
        agent: false,
        timeout: idleMs,
      },
      (response) => {
        tally(response);
        res.writeHead(response.statusCode, response.statusMessage, strip(response.headers));
        response.pipe(res);
      }
    );
    hold(upstream);
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });

  // https, wss and (in Chromium) ws go through CONNECT tunnels.
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    let url;
    try {
      // As https, so only 443 reads as the default port; 80 (ws:// in Chromium) stays explicit.
      url = new URL(`https://${req.url}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const port = Number(url.port || 443);
    const decision = full ? { ok: false } : await decide(url.hostname, port);
    if (!decision.ok || full) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    hold(client);
    tally(client);
    const upstream = connectTo(port, decision.address ?? url.hostname.replace(/^\[|\]$/g, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    hold(upstream);
    tally(upstream);
    upstream.setTimeout(idleMs, () => upstream.destroy());
    /** @type {import("node:net").Socket} */ (client).setTimeout(idleMs, () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  // A WebSocket upgrade sent without CONNECT is not tunnelled: refuse it rather than pass it on unchecked.
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));

  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  return {
    server: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    blocked,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
