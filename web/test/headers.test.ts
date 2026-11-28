import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  checkPublicKey,
  checkSiteUrl,
  checkUrl,
  contentSecurityPolicy,
  cspHash,
  headersFile,
  HW_THEME_STYLE_CSP,
  licensesFile,
  packageOf,
  siteScript,
  styleAttributes,
  styleElements,
} from '../src/build/headers';

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

describe('build-time settings', () => {
  it('takes https URLs without the trailing slash, and http only on this machine', () => {
    expect(checkUrl('U', ' https://auth.hintwise.org/ ', true)).toBe('https://auth.hintwise.org');
    expect(checkUrl('U', 'http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080');
    expect(checkUrl('U', undefined, false)).toBe('');
    expect(() => checkUrl('U', '', true)).toThrow(/U is not set/);
    expect(() => checkUrl('U', 'not a url', true)).toThrow(/U is not a URL/);
    expect(() => checkUrl('U', 'http://api.example.org', true)).toThrow(/must start with https/);
  });

  it('takes VITE_SITE_URL as an origin: required, https and on hintwise.org in production builds (R18.1-1)', () => {
    const SITE = 'https://screen-reader-journeys.hintwise.org';
    expect(checkSiteUrl('S', ` ${SITE}/ `, true)).toBe(SITE);
    expect(checkSiteUrl('S', 'https://hintwise.org', true)).toBe('https://hintwise.org');
    expect(() => checkSiteUrl('S', '', true)).toThrow(/S is not set/);
    expect(() => checkSiteUrl('S', 'http://screen-reader-journeys.hintwise.org', true)).toThrow(/must start with https/);
    expect(() => checkSiteUrl('S', 'http://127.0.0.1:4173', true)).toThrow(/must start with https/);
    expect(() => checkSiteUrl('S', 'https://screen-reader-journeys.netlify.app', true)).toThrow(/on hintwise\.org/);
    expect(() => checkSiteUrl('S', 'https://evilhintwise.org', true)).toThrow(/on hintwise\.org/);
    expect(() => checkSiteUrl('S', `${SITE}/runs`, true)).toThrow(/nothing after it/);
    expect(() => checkSiteUrl('S', `${SITE}/?x=1`, true)).toThrow(/nothing after it/);
    expect(() => checkSiteUrl('S', 'not a url', true)).toThrow(/S is not a URL/);
    // Elsewhere: empty is fine, and so is a loopback address (the tests).
    expect(checkSiteUrl('S', undefined, false)).toBe('');
    expect(checkSiteUrl('S', 'http://127.0.0.1:4173', false)).toBe('http://127.0.0.1:4173');
    expect(() => checkSiteUrl('S', 'http://example.org', false)).toThrow(/must start with https/);
  });

  it('writes site.js, which moves a page opened elsewhere and keeps the analytics script from counting it (R18.1-6)', () => {
    const SITE = 'https://screen-reader-journeys.hintwise.org';
    const run = (href: string) => {
      const url = new URL(href);
      const moved: string[] = [];
      const win: { hintwise?: { track: () => void } } = {};
      const location = { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, replace: (to: string) => moved.push(to) };
      new Function('window', 'location', siteScript(SITE))(win, location);
      return { moved, counted: !win.hintwise };
    };
    expect(run('https://screen-reader-journeys.netlify.app/index.html?x=1#/runs/abc')).toEqual({ moved: [`${SITE}/index.html?x=1#/runs/abc`], counted: false });
    expect(run(`${SITE}/#/runs`)).toEqual({ moved: [], counted: true });
    // The origin goes in as a string literal, quotes escaped (it is a checked origin in any case).
    expect(siteScript('https://a.hintwise.org/"x')).toContain('var origin = "https://a.hintwise.org/\\"x";');
  });

  it('takes the anon key and refuses a service-role or secret key', () => {
    expect(checkPublicKey('K', jwt({ role: 'anon' }), true)).toBe(jwt({ role: 'anon' }));
    expect(checkPublicKey('K', 'sb_publishable_abc', true)).toBe('sb_publishable_abc');
    expect(checkPublicKey('K', undefined, false)).toBe('');
    expect(() => checkPublicKey('K', '', true)).toThrow(/K is not set/);
    expect(() => checkPublicKey('K', jwt({ role: 'service_role' }), true)).toThrow(/secret \(service-role\) key/);
    expect(() => checkPublicKey('K', 'sb_secret_abc', true)).toThrow(/secret/);
  });
});

describe('the Content-Security-Policy', () => {
  it('hashes inline styles as CSP sources', () => {
    // The footer's own style hash, as claude-built-apps scripts/site-footer.mjs FOOTER_STYLE_CSP gives it.
    const footer = styleElements(readFileSync('index.html', 'utf8'));
    expect(footer).toHaveLength(1);
    expect(cspHash(footer[0])).toBe("'sha256-4VDViIffTKl8oDDJg58VHCVBOHSQm7GPM7eZ1fAKuzc='");
    expect(styleAttributes('<svg style="a:b"><g style="c:d"/></svg>')).toEqual(['a:b', 'c:d']);
  });

  it('allows exactly the Supabase URL, the API, Turnstile and the hashed styles', () => {
    const policy = contentSecurityPolicy({ supabaseUrl: 'https://auth.hintwise.org', apiUrl: 'https://api.test', styles: ['a{}', 'a{}'], styleAttributes: ['c:d'] });
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(policy).toContain(`style-src 'self' 'unsafe-hashes' ${cspHash('a{}')} ${cspHash('c:d')};`);
    expect(policy).toContain("connect-src 'self' https://auth.hintwise.org https://api.test;");
    expect(policy).toContain('frame-src https://challenges.cloudflare.com;');
    expect(policy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy({ supabaseUrl: '', apiUrl: '', styles: [], styleAttributes: [] })).toContain("style-src 'self'; img-src");
    expect(headersFile('P')).toBe('/*\n  Content-Security-Policy: P\n');
  });

  it("adds the theme switch's fallback style by hash, at the end of style-src, and changes nothing else", () => {
    const input = { supabaseUrl: 'https://auth.hintwise.org', apiUrl: 'https://api.test', styles: ['a{}'], styleAttributes: ['c:d'] };
    const before = contentSecurityPolicy(input);
    const after = contentSecurityPolicy({ ...input, styleHashes: [HW_THEME_STYLE_CSP] });
    expect(after).toBe(before.replace(/(style-src [^;]*)/, `$1 ${HW_THEME_STYLE_CSP}`));
    expect(after.split(HW_THEME_STYLE_CSP)).toHaveLength(2);
    // vite.config.ts passes it to the build's policy.
    expect(readFileSync('vite.config.ts', 'utf8')).toMatch(/styleHashes: \[HW_THEME_STYLE_CSP\]/);
  });
});

describe('licenses.txt', () => {
  it('lists the bundled packages with their licence texts, sorted', () => {
    const text = licensesFile([
      { name: 'zed', version: '1.0.0', license: 'MIT', text: 'MIT text\n' },
      { name: '@scope/a', version: '2.0.0', license: 'ISC', text: null },
    ]);
    expect(text.indexOf('@scope/a 2.0.0 (ISC)')).toBeLessThan(text.indexOf('zed 1.0.0 (MIT)'));
    expect(text).toContain('No licence file in the package.');
    expect(text).toContain('MIT text');
  });

  it('finds the package a module came from', () => {
    expect(packageOf('/w/node_modules/@supabase/auth-js/dist/index.js')).toEqual({ name: '@supabase/auth-js', root: '/w/node_modules/@supabase/auth-js' });
    expect(packageOf('\0/w/node_modules/tslib/x.js')?.name).toBe('tslib');
    expect(packageOf('/w/src/app.ts')).toBeNull();
  });
});
