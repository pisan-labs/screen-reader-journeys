// @vitest-environment jsdom
// The light and dark mode switch (claude-built-apps platform/src/theme/README.md): its two files,
// copied unchanged, the switch in the header, the colours in both modes, and print.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { contentSecurityPolicy } from '../src/build/headers';

const sha = (s: string | Uint8Array, enc: 'hex' | 'base64'): string => createHash('sha256').update(s).digest(enc);

// From claude-built-apps platform/src/theme/README.md, "The values" (main at 1975ac1). This
// repository cannot see the source, so the values are pasted: a newer copy there means updating
// both the files and these.
const HW_THEME_SHA256 = '8e78682bb6c0f0a30c20687122363ec3a5bf020df14faaa5235a99d065d71d9c';
const THEME_INIT_CSP = "'sha256-GhyjaPQKUCt6Zif2GMbTG7M6cUY6iW77/obk7CBvquk='";

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const main = readFileSync('src/main.ts', 'utf8');

describe('the copies of the shared switch', () => {
  it('hw-theme.js is the platform copy, unchanged', () => {
    expect(sha(readFileSync('src/lib/hw-theme.js'), 'hex')).toBe(HW_THEME_SHA256);
  });

  it('hw-theme-init.js is the platform copy, unchanged, served from the site root', () => {
    expect(`'sha256-${sha(readFileSync('public/hw-theme-init.js'), 'base64')}'`).toBe(THEME_INIT_CSP);
  });

  it('loads hw-theme-init.js in the head as a plain blocking script, before any stylesheet or other script', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const tag = '<script src="/hw-theme-init.js"></script>';
    expect(head.split(tag)).toHaveLength(2);
    const at = head.indexOf(tag);
    for (const later of ['<link rel="stylesheet"', '<style', '/hw-events.js', '/src/main.ts']) {
      const i = head.indexOf(later);
      expect(i === -1 || at < i, later).toBe(true);
    }
  });

  it('keeps the Content-Security-Policy strict: no inline script on the page, and no unsafe-inline', () => {
    // Every <script> has a src, so script-src 'self' covers the init file without a hash.
    expect([...html.matchAll(/<script\b([^>]*)>/g)].every(([, attrs]) => /\ssrc="/.test(attrs))).toBe(true);
    const policy = contentSecurityPolicy({ supabaseUrl: 'https://auth.hintwise.org', apiUrl: 'https://api.example', styles: [], styleAttributes: [] });
    const scriptSrc = policy.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).toBe("script-src 'self' https://challenges.cloudflare.com");
  });

  it('main.ts loads hw-theme.js first, before the stylesheet and the app', () => {
    const at = main.indexOf("import './lib/hw-theme.js';");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(main.indexOf("import './styles.css';"));
    expect(at).toBeLessThan(main.indexOf("from './app'"));
  });
});

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]): number => {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: number[], b: number[], share: number): number[] => a.map((v, i) => share * v + (1 - share) * b[i]);
const PRINT = /@media\s+print\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
const SCREEN_ATTR = /@media\s+screen\s*\{\s*:root\[data-theme="dark"\]\s*\{[^}]*\}\s*\}/g;
const SCREEN_DEVICE = /@media\s+screen\s+and\s+\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{[^}]*\}\s*\}/g;
const rules = (selector: string): string =>
  [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(',').some((x) => x.trim() === selector)).map((m) => m[2]).join(';');

describe('the palette', () => {
  const block = (re: RegExp): string | undefined => css.match(re)?.[1].replace(/\s+/g, ' ').trim();
  const tokens = (re: RegExp): Record<string, string> =>
    Object.fromEntries([...(css.match(re)?.[1] ?? '').matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const light = tokens(/:root\s*\{([^}]*)\}/);
  const dark = { ...light, ...tokens(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/) };

  it('is the same for the switch and for the device setting', () => {
    const attr = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
    expect(attr).toBeTruthy();
    expect(block(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/)).toBe(attr);
  });

  it('keeps both dark blocks to the screen, so paper gets the light set, and nothing else follows the device', () => {
    expect(css).toMatch(new RegExp(SCREEN_ATTR.source));
    expect(css).toMatch(new RegExp(SCREEN_DEVICE.source));
    expect(css.replace(SCREEN_ATTR, '').replace(SCREEN_DEVICE, '')).not.toMatch(/data-theme|prefers-color-scheme/);
    expect(block(/:root\s*\{([^}]*)\}/)).toContain('color-scheme: light;');
    expect(block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)).toContain('color-scheme: dark;');
  });

  it('sets every colour in both modes', () => {
    expect(Object.keys(light)).toHaveLength(14);
    const names = (re: RegExp): string[] => [...(css.match(re)?.[1] ?? '').matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort();
    expect(names(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)).toEqual(names(/:root\s*\{([^}]*)\}/));
  });

  it('meets WCAG AA for text, and 3:1 for field edges and the focus ring, in both modes', () => {
    const text: [string, string][] = [
      ['--text', '--bg'],
      ['--text', '--surface'],
      ['--muted', '--bg'],
      ['--muted', '--surface'],
      ['--accent', '--bg'],
      ['--accent', '--surface'],
      ['--on-accent', '--accent'],
      ['--text', '--bad-bg'],
      ['--bad', '--bg'],
      ['--ok', '--ok-bg'],
      ['--bad', '--bad-bg'],
      ['--busy', '--busy-bg'],
    ];
    for (const [theme, t] of [['light', light], ['dark', dark]] as const) {
      for (const [fg, bg] of text) expect(ratio(rgb(t[fg]), rgb(t[bg])), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of [['--border', '--bg'], ['--focus', '--bg'], ['--focus', '--surface']]) {
        expect(ratio(rgb(t[fg]), rgb(t[bg])), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("gives the switch's outline 3:1 against the header, in both modes", () => {
    // hw-theme.js draws the outline as a share of the text colour over what is behind it.
    const share = Number(readFileSync('src/lib/hw-theme.js', 'utf8').match(/currentColor (\d+)%/)![1]) / 100;
    expect(rules('.site-header')).toMatch(/background:\s*var\(--surface\)/);
    for (const t of [light, dark]) {
      const [ink, bg] = [rgb(t['--text']), rgb(t['--surface'])];
      expect(ratio(mix(ink, bg, share), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('writes no colour outside the token blocks', () => {
    const rest = css.replace(SCREEN_DEVICE, '').replace(SCREEN_ATTR, '').replace(/:root\s*\{[^}]*\}/g, '');
    expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
  });

  it('leaves the switch off paper, and prints a filled button\'s label in the ink', () => {
    const blocks = [...css.matchAll(PRINT)];
    expect(blocks).toHaveLength(1);
    expect(css.slice(blocks[0].index! + blocks[0][0].length).trim()).toBe('');
    const print = blocks[0][1];
    expect(print).toMatch(/(?:^|[\s,}])hw-theme-toggle\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    const within = (selector: string): string =>
      [...print.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(',').some((x) => x.trim() === selector)).map((m) => m[2]).join(';');
    // On screen a button is filled with the accent and labelled in --on-accent (white in light).
    expect(rules('button')).toMatch(/background:\s*var\(--accent\)/);
    expect(within('button:not(.secondary):not(.link-button)')).toMatch(/color:\s*var\(--text\)/);
    expect(within('.button')).toMatch(/color:\s*var\(--text\)/);
  });
});

describe('the switch in the header', () => {
  beforeAll(async () => {
    await import('../src/lib/hw-theme.js');
  });
  beforeEach(() => {
    window.hintwise!.theme!.set(null);
    localStorage.clear();
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1];
  });
  const toggle = (): HTMLElement => document.querySelector('header.site-header hw-theme-toggle')!;
  const button = (): HTMLButtonElement => toggle().shadowRoot!.querySelector('button')!;

  it('is last in the header, after the account controls, in a group that does not wrap it onto a line of its own', () => {
    expect(document.querySelectorAll('hw-theme-toggle')).toHaveLength(1);
    const end = toggle().parentElement!;
    expect(end.classList.contains('header-end')).toBe(true);
    expect(end.lastElementChild).toBe(toggle());
    expect(toggle().previousElementSibling?.id).toBe('account');
    expect(end.parentElement!.classList.contains('header-row')).toBe(true);
    expect(rules('.header-end')).toMatch(/display:\s*flex/);
    expect(rules('.header-end')).not.toMatch(/flex-wrap:\s*wrap/);
    expect(rules('hw-theme-toggle:not([hidden])')).toMatch(/flex:\s*none/);
    expect(rules('hw-theme-toggle:not([hidden])')).toMatch(/width:\s*var\(--hw-theme-toggle-size, 44px\)/);
  });

  it('says what it will do, switches the page at once and remembers the choice', () => {
    expect(button().getAttribute('aria-label')).toBe('Switch to dark mode');
    button().click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('hw-theme')).toBe('dark');
    expect(button().getAttribute('aria-label')).toBe('Switch to light mode');
    button().click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('hw-theme')).toBe('light');
  });
});
