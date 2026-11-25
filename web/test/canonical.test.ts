import { describe, expect, it } from 'vitest';
import { canonicalHref, canonicalOrigin, signInReturn } from '../src/canonical';

const SITE = 'https://screen-reader-journeys.hintwise.org';

describe('canonicalOrigin', () => {
  it('is the https origin VITE_SITE_URL names', () => {
    expect(canonicalOrigin({ VITE_SITE_URL: SITE })).toBe(SITE);
    expect(canonicalOrigin({ VITE_SITE_URL: ` ${SITE}/some/path ` })).toBe(SITE);
  });

  it('is null when unset, not https, or not a URL (local work stays where it is)', () => {
    expect(canonicalOrigin({})).toBeNull();
    expect(canonicalOrigin({ VITE_SITE_URL: '' })).toBeNull();
    expect(canonicalOrigin({ VITE_SITE_URL: 'http://screen-reader-journeys.hintwise.org' })).toBeNull();
    expect(canonicalOrigin({ VITE_SITE_URL: 'not a url' })).toBeNull();
  });

  it('takes http on a loopback host, for the tests', () => {
    expect(canonicalOrigin({ VITE_SITE_URL: 'http://127.0.0.1:4173' })).toBe('http://127.0.0.1:4173');
    expect(canonicalOrigin({ VITE_SITE_URL: 'http://localhost:5173/' })).toBe('http://localhost:5173');
    expect(canonicalOrigin({ VITE_SITE_URL: 'ftp://127.0.0.1/' })).toBeNull();
  });
});

describe('canonicalHref', () => {
  it('leaves the page where it is at the one address', () => {
    expect(canonicalHref(`${SITE}/`, SITE)).toBeNull();
    expect(canonicalHref(`${SITE}/#/runs/abc?x=1`, SITE)).toBeNull();
  });

  for (const [what, href, to] of [
    ['over http (before the certificate, or typed without https)', 'http://screen-reader-journeys.hintwise.org/#/runs/abc', `${SITE}/#/runs/abc`],
    ['under the netlify.app name', 'https://screen-reader-journeys.netlify.app/', `${SITE}/`],
    ['at a deploy preview', 'https://deploy-preview-17--screen-reader-journeys.netlify.app/?token_hash=t#/new', `${SITE}/?token_hash=t#/new`],
    ["at a deploy's own address", 'https://6b056bae--screen-reader-journeys.netlify.app/index.html', `${SITE}/index.html`],
  ]) {
    it(`moves a page opened ${what}, keeping its path, query and hash`, () => {
      expect(canonicalHref(href, SITE)).toBe(to);
    });
  }

  it('moves nothing without a configured address', () => {
    expect(canonicalHref('http://localhost:5173/', null)).toBeNull();
  });
});

describe('signInReturn', () => {
  it('is always the one address, whatever page sign-in starts from', () => {
    expect(signInReturn(SITE, { origin: SITE, pathname: '/index.html' })).toBe(`${SITE}/`);
  });

  it("is the page's own address without one (local work)", () => {
    expect(signInReturn(null, { origin: 'http://localhost:5173', pathname: '/' })).toBe('http://localhost:5173/');
  });
});
