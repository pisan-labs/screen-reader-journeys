/**
 * The dashboard's one address, VITE_SITE_URL (netlify.toml). Sign-in comes back only to an address
 * on the platform's allow-list (https://*.hintwise.org/**). A page opened anywhere else, over
 * http, under a netlify.app name, or at a deploy's own address, would send Supabase a return
 * address it refuses, and Supabase then falls back to the shared project's site_url: another app.
 * So the page first moves itself to the one address, and sign-in always returns there.
 */

/**
 * The origin VITE_SITE_URL names, or null when it is unset, or http on any host but a loopback
 * one (the build checks it too: src/build/headers.ts, checkSiteUrl). Loopback is for the tests.
 */
export function canonicalOrigin(env: Record<string, unknown> = import.meta.env): string | null {
  const raw = String(env.VITE_SITE_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Where the page at `href` should be instead, the same path, query and hash; null if it is there. */
export function canonicalHref(href: string, origin: string | null): string | null {
  if (!origin) return null;
  const url = new URL(href);
  if (url.origin === origin) return null;
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

/** The address sign-in returns to: the one address, or (without it) the page's own. */
export function signInReturn(origin: string | null, here: { origin: string; pathname: string }): string {
  return origin ? `${origin}/` : here.origin + here.pathname;
}
