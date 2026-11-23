// A forward proxy, local to one run, that every connection the browser makes goes through. It
// refuses loopback, private-network and other reserved addresses (unless the host is listed
// exactly in ALLOWED_TARGET_HOSTS), so a tested page cannot reach this server's own network or
// a cloud metadata endpoint, whatever its scripts, iframes, redirects or workers ask for. It
// resolves each host itself and connects to the address it checked, so DNS rebinding does not
// get past it.
//
// Requests a journey's setup fulfils with page.route (the STEM-Accessibility mock) never reach
// the network, so mocks still work.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { resolveEgress } from "./hosts.js";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);
const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));

/**
 * Start the proxy on 127.0.0.1. Returns `{ server: "http://127.0.0.1:<port>", blocked, close() }`,
 * where `blocked` lists the refused connections as "host:port (reason)".
 */
export async function startEgressProxy({ rules, lookup, idleMs = 60000 } = {}) {
  const blocked = [];
  const decide = async (host, port) => {
    const decision = await resolveEgress(host, port, rules, lookup);
    if (!decision.ok) blocked.push(`${host}:${port} (${decision.reason})`);
    return decision;
  };

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
    const decision = await decide(url.hostname, port);
    if (!decision.ok) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Blocked by the screen-reader-journeys network guard.\n");
      return;
    }
    const upstream = httpRequest(
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
    const decision = await decide(url.hostname, port);
    if (!decision.ok) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, decision.address ?? url.hostname.replace(/^\[|\]$/g, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.setTimeout(idleMs, () => upstream.destroy());
    client.setTimeout(idleMs, () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  // A WebSocket upgrade sent without CONNECT is not tunnelled: refuse it rather than pass it on unchecked.
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    blocked,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
