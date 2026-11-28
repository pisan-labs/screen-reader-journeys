/**
 * Build-time checks and Netlify's `_headers` for the dashboard (used by vite.config.ts).
 *
 * - The public values must be URLs (https, except on this machine) and a public key: a
 *   service-role or secret key would give every visitor full access to the database.
 * - The Content-Security-Policy allows exactly the Supabase URL and the API, the Turnstile
 *   check that sign-in may ask for, and, by hash, the inline styles the page uses: the HintWise
 *   footer's, the sign-in panel's, the Google G's and the theme switch's fallback.
 */
import { createHash } from 'node:crypto';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** A URL setting, without a trailing slash; '' when unset and not required. */
export function checkUrl(name: string, raw: string | undefined, required: boolean): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) {
    if (required) throw new Error(`${name} is not set. Set it in the Netlify site's environment variables.`);
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) throw new Error(`${name} must start with https://`);
  return value;
}

/**
 * VITE_SITE_URL, the dashboard's one address (src/canonical.ts), as an origin, or '' when unset.
 * Where it is required (Netlify's production builds) it must be https on hintwise.org, the only
 * place sign-in can return to (R18.1-1); elsewhere it may also be a loopback http address, for
 * the tests. A value with a path, query or credentials is refused, not trimmed.
 */
export function checkSiteUrl(name: string, raw: string | undefined, required: boolean): string {
  const value = (raw ?? '').trim();
  if (!value) {
    if (required) throw new Error(`${name} is not set. It belongs in netlify.toml, under [context.production.environment].`);
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && !required)) throw new Error(`${name} must start with https://`);
  if (required && parsed.hostname !== 'hintwise.org' && !parsed.hostname.endsWith('.hintwise.org')) {
    throw new Error(`${name} must be an address on hintwise.org, where sign-in can return: ${value}`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error(`${name} must be an origin, with nothing after it: ${value}`);
  return parsed.origin;
}

/**
 * dist/site.js, which index.html loads first (the build adds it): a page opened anywhere but
 * `origin` moves there before anything else runs. It also tells the analytics script that it
 * has already run (hw-events.js returns when window.hintwise.track exists), so the visit counts
 * once, at the one address (R18.1-6). src/main.ts moves the page too, if this did not.
 */
export function siteScript(origin: string): string {
  return `// Written by the build (web/src/build/headers.ts, siteScript): the dashboard's one address.
(function () {
  var origin = ${JSON.stringify(origin)};
  if (location.origin === origin) return;
  window.hintwise = { track: function () {} };
  location.replace(origin + location.pathname + location.search + location.hash);
})();
`;
}

/** The anon key, refusing a service-role or secret key. */
export function checkPublicKey(name: string, raw: string | undefined, required: boolean): string {
  const key = (raw ?? '').trim();
  if (!key && required) throw new Error(`${name} is not set. Set it in the Netlify site's environment variables.`);
  let role: unknown = null;
  try {
    role = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString()).role ?? null;
  } catch {
    // Not a JWT: the newer sb_publishable_ / sb_secret_ keys.
  }
  if (key.startsWith('sb_secret_') || role === 'service_role') {
    throw new Error(`${name} is a secret (service-role) key. Use the public anon key; no HintWise app holds the service-role key.`);
  }
  return key;
}

/** A CSP hash source for some text: 'sha256-…'. */
export function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The text of each <style> element in some HTML (the footer's sits in its shadow template). */
export function styleElements(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

/** The values of style="…" attributes in some markup (the Google G's SVG has two). */
export function styleAttributes(markup: string): string[] {
  return [...markup.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * The light and dark mode switch (src/lib/hw-theme.js, a copy of claude-built-apps
 * platform/src/theme/hw-theme.js) styles itself with a constructed stylesheet, which style-src
 * does not govern. Browsers without constructed stylesheets (Safari before 16.4) get a <style>
 * element with the same text instead: this is its hash, so the switch is styled there too.
 * test/theme.test.ts recomputes it from the copy.
 */
export const HW_THEME_STYLE_CSP = "'sha256-tNUGw7LItOaI5ajM98DiNLm0frYaQ8fVgVRz4/I6Xy4='";

export interface PolicyInput {
  supabaseUrl: string;
  apiUrl: string;
  /** Inline <style> elements the page uses. */
  styles: string[];
  /** style="…" attributes the page uses. */
  styleAttributes: string[];
  /** Hash sources for inline styles whose text is not at hand here (HW_THEME_STYLE_CSP). */
  styleHashes?: string[];
}

export function contentSecurityPolicy(input: PolicyInput): string {
  const hashes = [...new Set([...[...input.styles, ...input.styleAttributes].map(cspHash), ...(input.styleHashes ?? [])])];
  const styleSrc = ["'self'", ...(input.styleAttributes.length ? ["'unsafe-hashes'"] : []), ...hashes];
  return [
    "default-src 'none'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    `style-src ${styleSrc.join(' ')}`,
    "img-src 'self' data:",
    `connect-src ${["'self'", input.supabaseUrl, input.apiUrl].filter(Boolean).join(' ')}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Netlify's _headers file: the policy for every page. */
export function headersFile(policy: string): string {
  return `/*\n  Content-Security-Policy: ${policy}\n`;
}

export interface PackageInfo {
  name: string;
  version: string;
  license: string;
  text: string | null;
}

/** licenses.txt: the npm packages bundled into the page, with their licence texts. */
export function licensesFile(packages: PackageInfo[]): string {
  const parts = [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name} ${p.version} (${p.license})\n\n${p.text?.trim() || 'No licence file in the package.'}`);
  return `Third-party code bundled into the dashboard:\n\n${parts.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`;
}

/** The package a bundled module came from: its name and folder, or null for the app's own code. */
export function packageOf(moduleId: string): { name: string; root: string } | null {
  const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(moduleId.replace(/\\/g, '/').replace(/^\0/, ''));
  return match ? { name: match[2], root: match[1] } : null;
}
