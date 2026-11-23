// Which sites the server may test, and which addresses a tested page may reach.
//
// ALLOWED_TARGET_HOSTS is a comma-separated list of rules:
//
//   stem-accessibility.example.org   exactly this host
//   *.vercel.app                     any subdomain of vercel.app (not vercel.app itself)
//   127.0.0.1:4173                   a host on a port other than the scheme's default
//
// An empty list allows nothing. https is required, except for hosts listed exactly (no wildcard).
// IP addresses and localhost names never match a wildcard; they must be listed exactly. A rule
// without a port allows only the default port (443 for https, 80 for http).

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const isDomainName = (host) => host.length <= 253 && host.split(".").every((label) => LABEL.test(label));
const isLocalhostName = (host) => host === "localhost" || host.endsWith(".localhost");

/** "[::1]" → "::1"; other hosts unchanged. */
export const bareHost = (host) => host.replace(/^\[(.*)\]$/, "$1");

/** "ip", "localhost" or "domain", for a hostname as the WHATWG URL parser normalizes it. */
export function hostKind(host) {
  if (isIP(bareHost(host))) return "ip";
  if (isLocalhostName(host)) return "localhost";
  return "domain";
}

function parseRule(text) {
  const fail = (why) => {
    throw new Error(`ALLOWED_TARGET_HOSTS: "${text}" ${why}`);
  };
  if (/[/@?#\\\s]/.test(text) || text.includes("://")) fail("must be a host name, without a scheme, path or user name");
  const wildcard = text.startsWith("*.");
  const rest = wildcard ? text.slice(2) : text;
  if (rest.includes("*")) fail("may only use * as a leading \"*.\"");
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(rest);
  if (!match) fail("is not a host or host:port (write IPv6 addresses in brackets)");
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) fail("has an invalid port");
  let host;
  try {
    host = new URL(`http://${match[1]}`).hostname;
  } catch {
    fail("is not a valid host name");
  }
  const kind = hostKind(host);
  if (kind === "domain" && !isDomainName(host)) fail("is not a valid host name");
  if (wildcard && kind !== "domain") fail("uses a wildcard with an IP address or localhost; list those exactly");
  if (wildcard && !host.includes(".")) fail("is too broad; a wildcard needs at least two labels, e.g. *.vercel.app");
  return { text, wildcard, host, port, kind };
}

/** Parse ALLOWED_TARGET_HOSTS. Throws on a malformed rule, so a typo stops the server instead of allowing too much. */
export function parseAllowedHosts(value = "") {
  return String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map(parseRule);
}

const DEFAULT_PORTS = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 };

/** The rule that admits `url`'s host and port, or null. */
export function matchRule(url, rules, { exactOnly = false } = {}) {
  const host = url.hostname;
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  const kind = hostKind(host);
  for (const rule of rules) {
    if (rule.port === null ? url.port !== "" : rule.port !== port) continue;
    if (!rule.wildcard && rule.host === host) return rule;
    if (rule.wildcard && !exactOnly && kind === "domain" && host.endsWith(`.${rule.host}`)) return rule;
  }
  return null;
}

/**
 * Check a base URL a user asked the server to test. Returns `{ ok: true, url }` with the
 * normalized URL, or `{ ok: false, reason }` with a sentence for the user.
 */
export function checkTargetUrl(input, rules) {
  const refuse = (reason) => ({ ok: false, reason });
  if (typeof input !== "string" || input === "") return refuse("Enter the address of the site to test.");
  if (input.length > 2048) return refuse("The address is too long.");
  if (/[\s\u0000-\u001f\u007f\\]/.test(input)) return refuse("The address contains spaces, control characters or backslashes.");
  let url;
  try {
    url = new URL(input);
  } catch {
    return refuse("The address is not a valid URL. Write it in full, starting with https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return refuse("The address must start with https://.");
  if (url.username || url.password) return refuse("The address must not contain a user name or password.");
  if (url.hostname.endsWith(".")) return refuse("The host name must not end with a dot.");
  if (!rules.length) return refuse("This server has no allowed sites yet (ALLOWED_TARGET_HOSTS is empty), so it cannot test any address.");
  const rule = matchRule(url, rules);
  if (!rule) return refuse(`${url.host} is not one of the sites this server may test (${rules.map((r) => r.text).join(", ")}).`);
  if (url.protocol === "http:" && rule.wildcard) return refuse(`http is only allowed for hosts listed exactly; use https://${url.host}.`);
  url.hash = "";
  return { ok: true, url: url.href };
}

// Addresses a tested page must not reach unless the host is listed exactly: loopback, private
// networks, link-local (cloud metadata), carrier-grade NAT, multicast, documentation and other
// reserved ranges, and IPv6 forms that embed an IPv4 address. (BlockList checks IPv4-mapped
// IPv6 addresses, ::ffff:a.b.c.d, against the IPv4 ranges itself.)
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) PRIVATE.addSubnet(net, prefix, "ipv6");

/** True for an address the server must not visit on a user's behalf (or for anything that is not an IP address). */
export function isPrivateAddress(address) {
  const ip = bareHost(address);
  const version = isIP(ip);
  if (!version) return true;
  return PRIVATE.check(ip, version === 4 ? "ipv4" : "ipv6");
}

const systemLookup = async (host) => (await dnsLookup(host, { all: true, order: "ipv4first" })).map((a) => a.address);

/**
 * Decide whether the browser may open a connection to `host:port`, and to which address.
 * Hosts listed exactly are trusted as listed. Everything else must be, or resolve only to,
 * public addresses; the caller connects to the returned address, so a second DNS answer
 * (DNS rebinding) cannot redirect the connection.
 *
 * Returns `{ ok: true, address }` (address null means "resolve normally") or `{ ok: false, reason }`.
 */
export async function resolveEgress(host, port, rules, lookup = systemLookup) {
  let url;
  try {
    // The scheme whose default port this is, so that matchRule treats 80 and 443 as "no port".
    url = new URL(`${port === 443 ? "https" : "http"}://${host}:${port}`);
  } catch {
    return { ok: false, reason: `invalid host ${host}` };
  }
  if (matchRule(url, rules, { exactOnly: true })) return { ok: true, address: null };
  const kind = hostKind(url.hostname);
  if (kind === "localhost") return { ok: false, reason: `${url.hostname} is a local address` };
  if (kind === "ip") {
    const ip = bareHost(url.hostname);
    return isPrivateAddress(ip) ? { ok: false, reason: `${ip} is a private or reserved address` } : { ok: true, address: ip };
  }
  let addresses;
  try {
    addresses = await lookup(url.hostname);
  } catch (error) {
    return { ok: false, reason: `could not resolve ${url.hostname} (${error.code ?? error.message})` };
  }
  if (!addresses.length) return { ok: false, reason: `${url.hostname} has no address` };
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) return { ok: false, reason: `${url.hostname} resolves to ${blocked}, a private or reserved address` };
  return { ok: true, address: addresses[0] };
}
