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
// A run may move at most MAX_BYTES through the proxy, both directions together, counted on the
// browser's own connections to it: request lines, headers, bodies, uploads, CONNECT heads and
// tunnels alike. Then every open connection is closed and new ones are refused, so a page cannot
// use the server to move data for the whole run. A run may also look up at most MAX_NAMES host
// names, each once (which also pins its answer for the run).

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { resolveEgress, systemLookup } from "./hosts.js";

/**
 * The most refusals waiting to be sent: each result takes them (run-child.js), and the worker
 * keeps at most 200 different ones for the whole run (execute.js, MAX_BLOCKED).
 */
const MAX_BLOCKED_PER_SEND = 50;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_NAMES = 500;
/** The start of the entry that says a run reached MAX_BYTES; summaries keep it first. */
export const BYTE_LIMIT_ENTRY = "all connections (byte limit:";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);
const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));

/**
 * Start the proxy on 127.0.0.1. Returns `{ server: "http://127.0.0.1:<port>", blocked, close() }`,
 * where `blocked` lists the refused connections as "host:port (reason)".
 *
 * `connectTo` and `requestTo` (net.connect and http.request) are for the tests, which check that
 * they get the address that was checked, never the host name.
 *
 * @param {{ rules?: any[], lookup?: (host: string) => Promise<string[]>, idleMs?: number, maxBytes?: number, maxNames?: number, connectTo?: typeof connect, requestTo?: typeof httpRequest }} [options]
 */
export async function startEgressProxy({ rules, lookup = systemLookup, idleMs = 60000, maxBytes = MAX_BYTES, maxNames = MAX_NAMES, connectTo = connect, requestTo = httpRequest } = {}) {
  // Each refusal once a run, and at most MAX_BLOCKED_PER_SEND waiting: a page can make requests
  // in a loop.
  const blocked = [];
  const seen = new Set();
  // Each host name is looked up once a run, and at most `maxNames` of them: a page cannot make
  // the server send DNS queries for names it chooses without end.
  // A lookup that fails (a DNS hiccup, say) is not kept, so the host is tried again later, but it
  // still counts toward `maxNames` (R9.4).
  const names = new Map();
  let lookedUp = 0;
  const lookupOnce = (host) => {
    if (!names.has(host)) {
      if (lookedUp >= maxNames) return Promise.reject(new Error(`more than ${maxNames} host names in this run`));
      lookedUp += 1;
      const answer = lookup(host);
      names.set(host, answer);
      answer.catch(() => names.get(host) === answer && names.delete(host));
    }
    return names.get(host);
  };
  const decide = async (host, port) => {
    const decision = await resolveEgress(host, port, rules, lookupOnce);
    const entry = `${host}:${port} (${decision.reason})`;
    if (!decision.ok && blocked.length < MAX_BLOCKED_PER_SEND && !seen.has(entry)) {
      seen.add(entry);
      blocked.push(entry);
    }
    return decision;
  };

  // The bytes this run has moved: what was read from and written to each of the browser's
  // connections, from the sockets' own counters, taken at each request and tunnel, every 50 ms,
  // and when a connection closes. At the limit the browser's connections and every upstream one
  // (`hold`) are closed, and the entry goes first in `blocked`.
  let moved = 0;
  let full = false;
  /** @type {Map<import("node:net").Socket, number>} */
  const sockets = new Map();
  const open = new Set();
  /** @param {{ destroy: () => unknown, on: (event: "close", listener: () => void) => unknown }} thing */
  const hold = (thing) => {
    open.add(thing);
    thing.on("close", () => open.delete(thing));
  };
  const account = () => {
    for (const [socket, counted] of sockets) {
      const now = socket.bytesRead + socket.bytesWritten;
      moved += now - counted;
      sockets.set(socket, now);
    }
    if (!full && moved > maxBytes) {
      full = true;
      blocked.unshift(`${BYTE_LIMIT_ENTRY} the run moved its ${Math.round(maxBytes / 1024 / 1024)} MB through the network guard)`);
      for (const socket of sockets.keys()) socket.destroy();
      for (const each of open) each.destroy();
    }
    return full;
  };
  const ticker = setInterval(account, 50);
  ticker.unref();

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
    const decision = account() ? { ok: false } : await decide(url.hostname, port);
    if (!decision.ok || account()) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Blocked by the screen-reader-journeys network guard.\n");
      return;
    }
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
    const decision = account() ? { ok: false } : await decide(url.hostname, port);
    if (!decision.ok || account()) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connectTo(port, decision.address ?? url.hostname.replace(/^\[|\]$/g, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    hold(upstream);
    upstream.setTimeout(idleMs, () => upstream.destroy());
    /** @type {import("node:net").Socket} */ (client).setTimeout(idleMs, () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  // Every connection from the browser is counted from its first byte; none is taken once full.
  server.on("connection", (socket) => {
    if (full) return socket.destroy();
    sockets.set(socket, 0);
    socket.on("close", () => {
      account();
      sockets.delete(socket);
    });
  });

  // A WebSocket upgrade sent without CONNECT is not tunnelled: refuse it rather than pass it on unchecked.
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));

  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  return {
    server: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    blocked,
    close: () =>
      new Promise((done) => {
        clearInterval(ticker);
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
