// The HintWise pieces an own-repository app carries byte for byte (claude-built-apps
// docs/new-app-guide.md, section 6): the footer, the favicon and the analytics script.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync('index.html', 'utf8');
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

describe('HintWise footer, favicon and analytics', () => {
  it('embeds the footer once, unchanged, after the page and before </body>', () => {
    const open = '<site-footer data-site-footer>';
    const close = '</site-footer>';
    expect(html.split('data-site-footer')).toHaveLength(2);
    const start = html.indexOf(open);
    const markup = html.slice(start, html.indexOf(close, start) + close.length);
    // footerHtml('screen-reader-journeys') from claude-built-apps scripts/site-footer.mjs at 5aed40c.
    expect(sha256(markup)).toBe('e118bef7397a8d33f8f0dfb2ad57fcb79b156f25054b6343de16560da4344b42');
    expect(start).toBeGreaterThan(html.indexOf('</main>'));
    expect(start).toBeLessThan(html.indexOf('</body>'));
  });

  it("uses the HintWise icon as the favicon (platform/brand/favicon-link.html)", () => {
    const icon = /<link rel="icon" href="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(icon.startsWith('data:image/svg+xml,')).toBe(true);
    expect(icon).toContain('%23312E81');
  });

  it('copies hw-events.js unchanged and tags every page with it once', () => {
    expect(sha256(readFileSync('public/hw-events.js'))).toBe('d2833162b9f18f9f2fdb36dbd62440c13ee26c6600200d8e55ad32b907f00633');
    expect(html.match(/<script defer src="\/hw-events\.js" data-app="screen-reader-journeys"><\/script>/g)).toHaveLength(1);
    expect(html.indexOf('hw-events.js')).toBeLessThan(html.indexOf('</head>'));
  });

  it('says what the site does, and links STEM Accessibility\'s frontend on GitHub (the owner, 24 November)', () => {
    const about = /<section id="about" aria-labelledby="about-heading">([\s\S]*?)<\/section>/.exec(html)?.[1].replace(/\s+/g, ' ') ?? '';
    expect(about).toMatch(/<h2 id="about-heading">About this site<\/h2>/);
    expect(about).toMatch(/runs scripted journeys through a web page, by keyboard and with a screen reader's view of it, in a real browser on our server/);
    expect(about).toMatch(/built to check the STEM Accessibility project/);
    expect(about).toContain('<a href="https://github.com/stem-accessibility/frontend">STEM Accessibility\'s frontend on GitHub</a>');
  });

  it('says what it stores and that visits are counted without cookies', () => {
    const privacy = /<p id="privacy">([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/\s+/g, ' ') ?? '';
    expect(privacy).toMatch(/stored under your account/);
    expect(privacy).toMatch(/Supabase, US East/);
    expect(privacy).toMatch(/Delete my account/);
    expect(privacy).toMatch(/Finished runs are deleted once they are 30 days old, the next time the service runs/);
    expect(privacy).toMatch(/the number of runs you started is kept for today and yesterday \(UTC\)/);
    expect(privacy).toMatch(/at most your 20 latest runs/);
    expect(privacy).toMatch(/counted without cookies/);
    expect(privacy).not.toMatch(/no tracking/i);
  });

  it('links only to its own hintwise.org address, never to netlify.app or onrender.com', () => {
    expect(html).not.toMatch(/netlify\.app|onrender\.com/);
  });
});
