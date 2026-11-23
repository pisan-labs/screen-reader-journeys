// The hosted server's SSRF defences: which base URLs it accepts, which addresses a tested page
// may reach, and the egress proxy that enforces it. No network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
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

  for (const bad of ["*", "*.com", "https://example.org", "example.org/path", "user@example.org", "*.127.0.0.1", "*.0.0.1", "*.localhost", "ex*ample.org", "a.*.example.org", "example.org:0", "example.org:99999", "::1", "exa mple.org", "-bad-.example.org"]) {
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
  for (const ip of ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "::1", "[::1]", "::ffff:7f00:1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "2001:db8::1", "not-an-ip", ""]) {
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
    assert.deepEqual(await decide("8.8.8.8", 53), { ok: true, address: "8.8.8.8" });
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
});
