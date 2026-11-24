// The hosted server's SSRF defences: which base URLs it accepts, which addresses a tested page
// may reach, and the egress proxy that enforces it. No network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { startEgressProxy } from "../server/egress-proxy.js";
import { checkTargetUrl, isPrivateAddress, parseAllowedHosts, resolveEgress } from "../server/hosts.js";

const rules = parseAllowedHosts("*.vercel.app, stem-accessibility.example.org, 127.0.0.1:4173, *.bücher.example");
const ok = (url) => checkTargetUrl(url, rules);

describe("ALLOWED_TARGET_HOSTS parsing", () => {
  it("lowercases and keeps wildcards, exact hosts and ports", () => {
    const parsed = parseAllowedHosts(" *.Vercel.App ,Example.org,127.0.0.1:4173,[::1]:8080,");
    assert.deepEqual(
      parsed.map(({ wildcard, host, port, kind }) => ({ wildcard, host, port, kind })),
      [
        { wildcard: true, host: "vercel.app", port: null, kind: "domain" },
        { wildcard: false, host: "example.org", port: null, kind: "domain" },
        { wildcard: false, host: "127.0.0.1", port: 4173, kind: "ip" },
        { wildcard: false, host: "[::1]", port: 8080, kind: "ip" },
      ]
    );
  });

  it("is empty, and so denies everything, when unset", () => {
    assert.deepEqual(parseAllowedHosts(undefined), []);
    assert.deepEqual(parseAllowedHosts(""), []);
    assert.equal(checkTargetUrl("https://good.vercel.app/", []).ok, false);
  });

  for (const bad of ["*:443", "**", "*.*", "*.com", "https://example.org", "example.org/path", "user@example.org", "*.127.0.0.1", "*.0.0.1", "*.localhost", "ex*ample.org", "a.*.example.org", "example.org:0", "example.org:99999", "::1", "exa mple.org", "-bad-.example.org"]) {
    it(`refuses the rule "${bad}"`, () => assert.throws(() => parseAllowedHosts(bad), /ALLOWED_TARGET_HOSTS/));
  }
});

describe("base URL allowlist", () => {
  for (const url of [
    "https://good.vercel.app/",
    "https://frontend-git-branch-stem-accessibility.vercel.app/p/x?view=summary",
    "https://a.b.vercel.app",
    "https://GOOD.Vercel.APP/",
    "https://good.vercel.app:443/",
    "https://stem-accessibility.example.org/",
    "http://stem-accessibility.example.org/",
    "http://127.0.0.1:4173/",
    "http://2130706433:4173/",
    "https://shop.bücher.example/",
    "https://good%2Evercel.app/",
  ]) {
    it(`accepts ${url}`, () => assert.equal(ok(url).ok, true, ok(url).reason));
  }

  it("normalizes the URL it accepts", () => {
    assert.equal(ok("https://GOOD.Vercel.APP:443/path#frag").url, "https://good.vercel.app/path");
    assert.equal(ok("http://0x7f.0.0.1:4173").url, "http://127.0.0.1:4173/");
    assert.equal(ok("https://shop.bücher.example/").url, "https://shop.xn--bcher-kva.example/");
  });

  for (const [url, why] of [
    ["https://vercel.app/", /not one of the sites/],
    ["https://evilvercel.app/", /not one of the sites/],
    ["https://vercel.app.evil.com/", /not one of the sites/],
    ["https://good.vercel.app.evil.com/", /not one of the sites/],
    ["https://good.vercel.app@evil.com/", /user name or password/],
    ["https://user:pass@good.vercel.app/", /user name or password/],
    ["https://evil.com#@good.vercel.app", /not one of the sites/],
    ["https://evil.com?x=.vercel.app", /not one of the sites/],
    ["https://evil.com\\@good.vercel.app", /backslashes/],
    ["https://good.vercel.app./", /end with a dot/],
    ["https://good.vercel.app:8443/", /not one of the sites/],
    ["http://good.vercel.app/", /http is only allowed for hosts listed exactly/],
    ["http://127.0.0.1/", /not one of the sites/],
    ["http://127.0.0.1:4174/", /not one of the sites/],
    ["http://127.0.0.2:4173/", /not one of the sites/],
    ["http://localhost:4173/", /not one of the sites/],
    ["https://localhost/", /not one of the sites/],
    ["http://[::1]:4173/", /not one of the sites/],
    ["https://[::ffff:127.0.0.1]/", /not one of the sites/],
    ["https://169.254.169.254/latest/meta-data/", /not one of the sites/],
    ["https://10.0.0.1/", /not one of the sites/],
    ["https://2130706433/", /not one of the sites/],
    ["ftp://good.vercel.app/", /must start with https/],
    ["file:///etc/passwd", /must start with https/],
    ["javascript:alert(1)", /must start with https/],
    ["data:text/html,hi", /must start with https/],
    ["//good.vercel.app/", /not a valid URL/],
    ["good.vercel.app", /not a valid URL/],
    [" https://good.vercel.app/", /spaces/],
    ["https://good.vercel.app/\n", /spaces/],
    ["https://evil.com%2f.vercel.app/", /not a valid URL/],
    ["", /Enter the address/],
    [42, /Enter the address/],
    [`https://good.vercel.app/${"a".repeat(2100)}`, /too long/],
  ]) {
    it(`refuses ${JSON.stringify(url).slice(0, 60)}`, () => {
      const result = ok(url);
      assert.equal(result.ok, false);
      assert.match(result.reason, why);
    });
  }
});

describe("private and reserved addresses", () => {
  for (const ip of ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "::1", "[::1]", "::ffff:7f00:1", "::ffff:127.0.0.1", "::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::ffff:0:127.0.0.1", "::ffff:0:a9fe:a9fe", "64:ff9b::a00:1", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "2001:db8::1", "not-an-ip", ""]) {
    it(`${ip || "(empty)"} is private`, () => assert.equal(isPrivateAddress(ip), true));
  }
  for (const ip of ["8.8.8.8", "76.76.21.21", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "[2606:4700::1111]"]) {
    it(`${ip} is public`, () => assert.equal(isPrivateAddress(ip), false));
  }
});

describe("egress decisions", () => {
  const dns = {
    "cdn.example.com": ["93.184.216.34"],
    "rebind.example.com": ["93.184.216.34", "10.0.0.1"],
    "internal.example.com": ["192.168.0.10"],
    "v6only.example.com": ["::1"],
    "good.vercel.app": ["76.76.21.21"],
    "evil.vercel.app": ["127.0.0.1"],
  };
  const lookup = async (host) => {
    if (!dns[host]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return dns[host];
  };
  const decide = (host, port) => resolveEgress(host, port, rules, lookup);

  it("trusts a host listed exactly, on its port, and leaves resolution to the system", async () => {
    assert.deepEqual(await decide("127.0.0.1", 4173), { ok: true, address: null });
  });
  it("allows public hosts and pins the checked address", async () => {
    assert.deepEqual(await decide("cdn.example.com", 443), { ok: true, address: "93.184.216.34" });
    assert.deepEqual(await decide("good.vercel.app", 443), { ok: true, address: "76.76.21.21" });
    assert.deepEqual(await decide("8.8.8.8", 443), { ok: true, address: "8.8.8.8" });
  });
  for (const [host, port, why] of [
    ["127.0.0.1", 5432, /private/],
    ["127.0.0.1", 80, /private/],
    ["localhost", 4173, /local address/],
    ["app.localhost", 443, /local address/],
    ["169.254.169.254", 80, /private/],
    ["[::1]", 443, /private/],
    ["[::ffff:7f00:1]", 443, /private/],
    ["rebind.example.com", 443, /resolves to 10\.0\.0\.1/],
    ["internal.example.com", 80, /resolves to 192\.168/],
    ["v6only.example.com", 443, /resolves to ::1/],
    ["evil.vercel.app", 443, /resolves to 127\.0\.0\.1/],
    ["missing.example.com", 443, /could not resolve/],
    // Hosts not listed exactly: ports 80 and 443 only, checked before any lookup.
    ["8.8.8.8", 53, /port 53 is only allowed for hosts listed exactly/],
    ["cdn.example.com", 22, /port 22 is only allowed for hosts listed exactly/],
    ["good.vercel.app", 8443, /port 8443/],
    ["missing.example.com", 25, /port 25/],
  ]) {
    it(`blocks ${host}:${port}`, async () => {
      const decision = await decide(host, port);
      assert.equal(decision.ok, false);
      assert.match(decision.reason, why);
    });
  }
});

describe("egress proxy", () => {
  let site;
  let other;
  let proxy;
  const hits = [];
  const listen = (handler) =>
    new Promise((done) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => done(server));
    });

  before(async () => {
    site = await listen((req, res) => {
      hits.push(`site ${req.url}`);
      res.end("hello");
    });
    other = await listen((req, res) => {
      hits.push(`other ${req.url}`);
      res.end("secret");
    });
    proxy = await startEgressProxy({ rules: parseAllowedHosts(`127.0.0.1:${site.address().port}`), lookup: async () => ["127.0.0.1"] });
  });
  after(async () => {
    await proxy.close();
    site.close();
    other.close();
  });

  const viaProxy = (url) =>
    new Promise((resolve, reject) => {
      const { port } = new URL(proxy.server);
      const req = request({ host: "127.0.0.1", port, path: url, method: "GET", headers: { host: new URL(url).host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
  const tunnel = (authority) =>
    new Promise((resolve, reject) => {
      const { port } = new URL(proxy.server);
      const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });

  it("forwards requests to the allowed site", async () => {
    const response = await viaProxy(`http://127.0.0.1:${site.address().port}/page`);
    assert.deepEqual(response, { status: 200, body: "hello" });
    assert.ok(hits.includes("site /page"));
  });

  it("refuses other ports, localhost and metadata addresses without connecting", async () => {
    assert.equal((await viaProxy(`http://127.0.0.1:${other.address().port}/secret`)).status, 403);
    assert.equal((await viaProxy(`http://localhost:${site.address().port}/secret`)).status, 403);
    assert.equal((await viaProxy("http://169.254.169.254/latest/meta-data/")).status, 403);
    assert.equal(await tunnel(`127.0.0.1:${other.address().port}`), 403);
    assert.equal(await tunnel(`[::1]:443`), 403);
    assert.equal(await tunnel(`rebind.example.com:443`), 403);
    assert.equal(await tunnel("localhost:80"), 403);
    assert.ok(proxy.blocked.some((b) => b.startsWith("localhost:80 ")), "a tunnel to port 80 is checked as port 80");
    assert.deepEqual(hits.filter((h) => h.includes("secret")), []);
    assert.ok(proxy.blocked.some((b) => b.startsWith(`127.0.0.1:${other.address().port}`)), proxy.blocked.join("\n"));
  });

  it("tunnels CONNECT to the allowed site", async () => {
    assert.equal(await tunnel(`127.0.0.1:${site.address().port}`), 200);
  });

  it("keeps at most 50 distinct refusals, however many requests a page makes", async () => {
    proxy.blocked.splice(0);
    for (let i = 0; i < 80; i++) assert.equal(await tunnel(`10.0.${i}.1:443`), 403);
    for (let i = 0; i < 20; i++) await tunnel("10.0.0.1:443");
    assert.equal(proxy.blocked.length, 50);
    assert.equal(new Set(proxy.blocked).size, 50);
  });
});

describe("egress proxy, when the other side misbehaves", () => {
  const servers = [];
  let proxy;
  let silent;
  let rude;
  let closed;
  const tcp = (onSocket) =>
    new Promise((done) => {
      const server = net.createServer(onSocket);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => done(/** @type {net.AddressInfo} */ (server.address()).port));
    });

  before(async () => {
    silent = await tcp(() => {}); // accepts, never answers
    rude = await tcp((socket) => socket.destroy()); // hangs up at once
    closed = await tcp(() => {});
    await new Promise((done) => servers.pop().close(done)); // now nothing listens on it
    const allowed = [silent, rude, closed].map((port) => `127.0.0.1:${port}`).join(", ");
    proxy = await startEgressProxy({ rules: parseAllowedHosts(allowed), lookup: async () => ["127.0.0.1"], idleMs: 200 });
  });
  after(async () => {
    await proxy.close();
    for (const server of servers) server.close();
  });

  /** Send `text` to the proxy on a plain socket; resolves to all it answers once it closes. */
  const raw = (text) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(Number(new URL(proxy.server).port), "127.0.0.1", () => socket.write(text));
      let answer = "";
      const limit = setTimeout(() => {
        socket.destroy();
        reject(new Error(`the proxy kept the connection open: ${answer}`));
      }, 5000);
      socket.on("data", (chunk) => (answer += chunk));
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(limit);
        resolve(answer);
      });
    });
  const get = (port, headers = "") => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}Connection: close\r\n\r\n`;

  it("answers 502 when the site hangs up", async () => {
    assert.match(await raw(get(rude)), /^HTTP\/1\.1 502/);
  });

  it("answers 502 when the site never answers, once the idle limit passes", async () => {
    assert.match(await raw(get(silent)), /^HTTP\/1\.1 502/);
  });

  it("closes a tunnel to an allowed site that cannot be reached", async () => {
    assert.equal(await raw(`CONNECT 127.0.0.1:${closed} HTTP/1.1\r\nHost: 127.0.0.1:${closed}\r\n\r\n`), "");
  });

  it("closes a tunnel that stays idle", async () => {
    assert.match(await raw(`CONNECT 127.0.0.1:${silent} HTTP/1.1\r\nHost: 127.0.0.1:${silent}\r\n\r\n`), /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/);
  });

  it("refuses a WebSocket upgrade sent without CONNECT, rather than pass it on unchecked", async () => {
    const upgrade = `GET http://127.0.0.1:${silent}/ HTTP/1.1\r\nHost: 127.0.0.1:${silent}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;
    assert.match(await raw(upgrade), /^HTTP\/1\.1 403/);
  });

  it("answers 400 to what is not a proxy request: a relative URL, or another scheme", async () => {
    assert.match(await raw("GET / HTTP/1.1\r\nHost: example.org\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
    assert.match(await raw("GET ftp://example.org/ HTTP/1.1\r\nHost: example.org\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
  });

  it("answers 400 to a CONNECT whose target is not a host and port", async () => {
    assert.match(await raw("CONNECT %%:443 HTTP/1.1\r\nHost: x\r\n\r\n"), /^HTTP\/1\.1 400/);
  });
});

describe('ALLOWED_TARGET_HOSTS="*": any public site', () => {
  const any = parseAllowedHosts("*");
  const mixed = parseAllowedHosts("*, 127.0.0.1:4173");
  const check = (url, rules = any) => checkTargetUrl(url, rules);

  it("parses alone or with exact rules", () => {
    assert.deepEqual(any.map((r) => [r.text, Boolean(r.any)]), [["*", true]]);
    assert.deepEqual(mixed.map((r) => r.text), ["*", "127.0.0.1:4173"]);
  });

  for (const [url, normalized] of [
    ["https://example.org/", "https://example.org/"],
    ["http://example.org/page?x=1#top", "http://example.org/page?x=1"],
    ["https://www.example.co.uk:443/", "https://www.example.co.uk/"],
    ["http://example.org:80/", "http://example.org/"],
    ["https://93.184.216.34/", "https://93.184.216.34/"],
    ["https://[2606:4700:4700::1111]/", "https://[2606:4700:4700::1111]/"],
  ]) {
    it(`accepts ${url}`, () => assert.deepEqual(check(url), { ok: true, url: normalized }));
  }

  it("still trusts an exact rule listed with it, on its own port", () => {
    assert.equal(check("http://127.0.0.1:4173/", mixed).ok, true);
    assert.equal(check("http://127.0.0.1:4174/", mixed).ok, false);
  });

  for (const [url, why] of [
    ["http://127.0.0.1/", /127\.0\.0\.1 is a private or reserved address/],
    ["http://0x7f000001/", /127\.0\.0\.1 is a private or reserved address/],
    ["https://[::1]/", /::1 is a private or reserved address/],
    ["https://10.0.0.1/", /private or reserved/],
    ["https://172.16.0.1/", /private or reserved/],
    ["https://192.168.1.1/", /private or reserved/],
    ["http://169.254.169.254/latest/meta-data/", /169\.254\.169\.254 is a private or reserved address/],
    ["http://[fd00:ec2::254]/", /fd00:ec2::254 is a private or reserved address/],
    ["https://100.64.0.1/", /private or reserved/],
    ["https://224.0.0.1/", /private or reserved/],
    ["https://0.0.0.0/", /private or reserved/],
    ["https://[::]/", /private or reserved/],
    ["https://[::ffff:127.0.0.1]/", /private or reserved/],
    ["https://[fe80::1]/", /private or reserved/],
    ["https://localhost/", /localhost is a local address/],
    ["https://app.localhost/", /local address/],
    ["https://intranet/", /intranet is not a full host name/],
    ["https://example.org:8443/", /Port 8443 is not allowed; this server tests sites on ports 80 and 443 only/],
    ["http://example.org:443/", /Port 443 is not allowed/],
    ["https://user:secret@example.org/", /must not contain a user name or password/],
    ["ftp://example.org/", /must start with https/],
    ["https://example.org./", /must not end with a dot/],
  ]) {
    it(`refuses ${url}`, () => {
      const result = check(url);
      assert.equal(result.ok, false);
      assert.match(result.reason, why);
    });
  }

  describe("at every connection the browser makes", () => {
    const dns = {
      "public.example": ["93.184.216.34"],
      "inside.example": ["10.1.2.3"],
      "mixed.example": ["93.184.216.34", "192.168.0.1"],
      "metadata.example": ["169.254.169.254"],
      "mapped.example": ["::ffff:10.0.0.1"],
      "loop6.example": ["::1"],
    };
    const lookup = async (host) => {
      if (!dns[host]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return dns[host];
    };
    const decide = (host, port, rules = any) => resolveEgress(host, port, rules, lookup);

    it("resolves a public site and connects to the checked address, never trusting it as listed", async () => {
      assert.deepEqual(await decide("public.example", 443), { ok: true, address: "93.184.216.34" });
      assert.deepEqual(await decide("93.184.216.34", 80), { ok: true, address: "93.184.216.34" });
    });

    it("trusts only the exact rules listed with it", async () => {
      assert.deepEqual(await decide("127.0.0.1", 4173, mixed), { ok: true, address: null });
    });

    for (const [host, port, why] of [
      ["inside.example", 443, /resolves to 10\.1\.2\.3/],
      ["mixed.example", 443, /resolves to 192\.168\.0\.1/],
      ["metadata.example", 80, /resolves to 169\.254\.169\.254/],
      ["mapped.example", 443, /resolves to ::ffff:10\.0\.0\.1/],
      ["loop6.example", 443, /resolves to ::1/],
      ["127.0.0.1", 443, /private/],
      ["[::ffff:7f00:1]", 443, /private/],
      ["localhost", 80, /local address/],
      ["public.example", 22, /port 22/],
      ["93.184.216.34", 8080, /port 8080/],
      ["missing.example", 443, /could not resolve/],
    ]) {
      it(`blocks ${host}:${port}`, async () => {
        const decision = await decide(host, port);
        assert.equal(decision.ok, false);
        assert.match(decision.reason, why);
      });
    }
  });
});

describe('the egress proxy under "*"', () => {
  let site;
  let proxy;
  const hits = [];
  before(async () => {
    // An allowed site (listed exactly, as a stand-in for a public one) that redirects inside.
    site = await new Promise((done) => {
      const server = createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(302, { Location: "http://inside.example/secret" }).end();
      });
      server.listen(0, "127.0.0.1", () => done(server));
    });
    const dns = { "inside.example": ["127.0.0.1"], "metadata.example": ["169.254.169.254"], "public.example": ["93.184.216.34"] };
    const lookup = async (host) => {
      if (!dns[host]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return dns[host];
    };
    proxy = await startEgressProxy({ rules: parseAllowedHosts(`*, 127.0.0.1:${site.address().port}`), lookup });
  });
  after(async () => {
    await proxy.close();
    site.close();
  });

  const viaProxy = (url) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(new URL(proxy.server).port), path: url, method: "GET", headers: { host: new URL(url).host } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
      });
      req.on("error", reject);
      req.end();
    });
  const tunnel = (authority) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(new URL(proxy.server).port), method: "CONNECT", path: authority });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });

  it("decides each connection on its own: a redirect to a host that resolves inside is refused", async () => {
    const first = await viaProxy(`http://127.0.0.1:${site.address().port}/`);
    assert.deepEqual(first, { status: 302, location: "http://inside.example/secret" });
    assert.equal((await viaProxy(first.location)).status, 403);
    assert.deepEqual(hits, ["/"], "the redirect target was never reached");
    assert.ok(proxy.blocked.some((b) => b.startsWith("inside.example:80 ") && /resolves to 127\.0\.0\.1/.test(b)), proxy.blocked.join("\n"));
  });

  it("refuses tunnels to private, metadata and loopback addresses, and to other ports", async () => {
    assert.equal(await tunnel("inside.example:443"), 403);
    assert.equal(await tunnel("metadata.example:443"), 403);
    assert.equal(await tunnel("169.254.169.254:443"), 403);
    assert.equal(await tunnel("[::ffff:127.0.0.1]:443"), 403);
    assert.equal(await tunnel("public.example:22"), 403);
    assert.equal(await tunnel("93.184.216.34:8443"), 403);
    assert.ok(proxy.blocked.some((b) => b.startsWith("public.example:22 ") && /port 22/.test(b)), proxy.blocked.join("\n"));
  });
});
