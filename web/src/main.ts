/**
 * Mounts the dashboard (src/app.ts) with the real Supabase client, the platform's sign-in and the
 * API at VITE_API_URL. Without the build's values it says what is missing.
 */
import './styles.css';
import { startDashboard, type DashboardClient } from './app';
import { currentToken, mountSignIn, onAuth, signOut } from './lib/auth';
import { getSupabase, hasSupabase } from './lib/supabase';

const apiUrl = String(import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

if (!hasSupabase() || !apiUrl) {
  const view = document.getElementById('view');
  view?.replaceChildren();
  const h1 = document.createElement('h1');
  h1.textContent = 'Setup needed';
  const p = document.createElement('p');
  p.textContent = 'Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_API_URL, then build the dashboard again. docs/deploy.md explains where they come from.';
  view?.append(h1, p);
} else {
  const client = getSupabase();
  void startDashboard({
    doc: document,
    win: window,
    client: client as unknown as DashboardClient,
    apiUrl,
    fetch: (input, init) => fetch(input, init),
    token: () => currentToken(client),
    onAuth: (callback) => onAuth((_user, session) => callback(session), client),
    signOut: () => signOut(client),
    mountSignIn: (el) => mountSignIn(el, { client }),
  });
}
