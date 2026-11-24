// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Session } from '@supabase/supabase-js';
import { BASE_URL_KEY, duration, startDashboard, type Catalog, type DashboardClient, type DashboardDeps, type Progress, type Run } from '../src/app';

const RUN_ID = '3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';
const HOME = 'targets/generic/home-tab-order.journey.js';
const CATALOG: Catalog = {
  journeys: [
    { path: HOME, name: 'Home page: Tab order', description: 'Every Tab stop on the home page.' },
    { path: 'targets/x/other.journey.js', name: 'Other' },
  ],
  modes: ['walker', 'virtual'],
  allowed_hosts: ['*.vercel.app'],
};
const SESSION = { access_token: 'token-a', user: { id: 'u1', email: 'a@example.org' } } as unknown as Session;

const body = readFileSync('index.html', 'utf8').match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';

function run(fields: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    base_url: 'https://preview.vercel.app/',
    journeys: [HOME],
    modes: ['walker'],
    status: 'done',
    error: null,
    created_at: '2026-11-23T10:00:00Z',
    started_at: '2026-11-23T10:00:05Z',
    finished_at: '2026-11-23T10:00:40Z',
    summary: { passed: 1, failed: 0, errored: 0, files: ['home-page-tab-order.walker.md', 'summary.md'], blocked_requests: [] },
    run_results: [
      { journey: HOME, mode: 'walker', status: 'pass', checks_passed: 2, checks_total: 2, errors: 1, warnings: 0, report_path: 'home-page-tab-order.walker.md' },
    ],
    ...fields,
  };
}

type Answer = { status: number; body?: unknown } | Error;

/** A fake supabase-js client for the two tables, recording what was asked. */
function fakeClient({ runs = [] as Run[], runsError = null as string | null, reportsError = null as string | null, deleteError = null as string | null } = {}) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      if (table === 'runs') {
        return {
          select: (columns: string) => ({
            order: () => ({
              limit: async (n: number) => {
                calls.push(`runs select ${columns} limit ${n}`);
                return runsError ? { data: null, error: { message: runsError } } : { data: runs, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: async (_column: string, id: string) => {
              calls.push(`runs delete ${id}`);
              return { data: null, error: deleteError ? { message: deleteError } : null };
            },
          }),
        };
      }
      return {
        select: (columns: string) => ({
          eq: (_c: string, runId: string) => ({
            in: async (_p: string, paths: string[]) => {
              calls.push(`reports ${columns} ${runId} ${paths.join(',')}`);
              if (reportsError) return { data: null, error: { message: reportsError } };
              const missing = paths.filter((p) => p.startsWith('gone'));
              return {
                data: paths.filter((p) => !missing.includes(p)).map((path) => (columns.includes('body') ? { path, body: `<script>alert(1)</script> ${path}` } : { path, content_type: 'text/html' })),
                error: null,
              };
            },
          }),
        }),
      };
    },
  };
  return { client: client as unknown as DashboardClient, calls };
}

interface Setup {
  session?: Session | null;
  answers?: Record<string, Answer | Answer[]>;
  client?: ReturnType<typeof fakeClient>;
  hash?: string;
  confirm?: boolean;
}

async function setup({ session = SESSION, answers = {}, client = fakeClient(), hash = '', confirm = true }: Setup = {}) {
  document.body.innerHTML = body;
  window.location.hash = hash;
  // Let the hashchange events from setting the hash (here and in afterEach) fire before the
  // dashboard listens, so they do not redraw it under the test.
  await tick(1);
  localStorage.clear();
  const requests: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  let authCallback: (s: Session | null) => void = () => {};
  const signOut = vi.fn(async () => authCallback(null));
  vi.spyOn(window, 'confirm').mockReturnValue(confirm);
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.test', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null });
    const key = `${init?.method ?? 'GET'} ${path}`;
    let answer = answers[key];
    if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift()! : answer[0];
    if (!answer) answer = { status: 404, body: { error: 'Not found.' } };
    if (answer instanceof Error) throw answer;
    const { status, body: payload } = answer;
    return new Response(payload === undefined ? 'not json' : JSON.stringify(payload), { status });
  });
  const deps: DashboardDeps = {
    doc: document,
    win: window,
    client: client.client,
    apiUrl: 'https://api.test',
    fetch: fetch as unknown as typeof globalThis.fetch,
    token: async () => (current ? current.access_token : null),
    onAuth: (callback) => {
      authCallback = (s) => {
        current = s;
        callback(s);
      };
      authCallback(session);
    },
    signOut,
    mountSignIn: (el) => (el.textContent = 'sign-in here'),
    pollMs: 5,
  };
  let current: Session | null = session;
  await startDashboard(deps);
  return { requests, fetch, signOut, signIn: (s: Session | null) => authCallback(s), calls: client.calls };
}

const view = () => document.getElementById('view')!;
const alertText = () => document.getElementById('alert')!.textContent ?? '';
const statusText = () => document.getElementById('status')!.textContent ?? '';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick(5);
  }
  throw new Error(`timed out waiting for ${what}; alert: ${alertText()}; status: ${statusText()}; view: ${view().textContent?.slice(0, 300)}`);
}

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:report'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('the dashboard', () => {
  it('needs its page elements', async () => {
    document.body.innerHTML = '<div id="view"></div>';
    await expect(startDashboard({ doc: document, win: window } as unknown as DashboardDeps)).rejects.toThrow(/index.html needs #account/);
  });

  it('signed out: explains the service and where to sign in, and mounts the sign-in', async () => {
    await setup({ session: null });
    expect(view().querySelector('h1')?.textContent).toBe('Screen Reader Journeys');
    expect(view().textContent).toMatch(/Sign in at the top of the page, with Google or a code/);
    expect(document.getElementById('account')!.textContent).toBe('sign-in here');
    expect(document.title).toBe('Sign in – Screen Reader Journeys');
  });

  it('signed in: lists no runs yet and offers the form, with every journey and both modes', async () => {
    await setup({ answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => !!document.getElementById('base-url'), 'the form');
    expect(view().textContent).toMatch(/You have not started any runs yet/);
    expect(document.getElementById('start-hint')!.textContent).toMatch(/waits about a minute while it wakes/);
    expect(view().textContent).toMatch(/This server may test \*\.vercel\.app/);
    const boxes = [...view().querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((b) => [b.value, b.checked])).toEqual([
      [HOME, false],
      ['targets/x/other.journey.js', false],
      ['walker', true],
      ['virtual', true],
    ]);
    expect(document.getElementById('journey-0')!.getAttribute('aria-describedby')).toBe('journey-0-hint');
    expect(document.getElementById('journey-1')!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('says when the server tests any public address ("*")', async () => {
    await setup({ answers: { 'GET /journeys': { status: 200, body: { ...CATALOG, allowed_hosts: ['*'] } } } });
    await until(() => !!document.getElementById('base-url'), 'the form');
    expect(view().textContent).toMatch(/may test any public address, with http or https on ports 80 and 443\./);
    // What happens to the page, said where the address is entered (PManager, 24 November).
    expect(document.getElementById('base-url-hint')!.textContent).toMatch(/The page is opened by a browser on our server, over the public internet\.$/);
    expect(view().textContent).not.toMatch(/may test \*/);
  });

  it('names the exact sites listed with "*"', async () => {
    await setup({ answers: { 'GET /journeys': { status: 200, body: { ...CATALOG, allowed_hosts: ['*', '127.0.0.1:4173'] } } } });
    await until(() => !!document.getElementById('base-url'), 'the form');
    expect(view().textContent).toMatch(/any public address, with http or https on ports 80 and 443, and 127\.0\.0\.1:4173\./);
  });

  it('says when the server allows no sites', async () => {
    await setup({ answers: { 'GET /journeys': { status: 200, body: { ...CATALOG, allowed_hosts: [] } } } });
    await until(() => !!document.getElementById('base-url'), 'the form');
    expect(view().textContent).toMatch(/no allowed sites yet/);
  });

  it('lists runs, newest first, with their results', async () => {
    const runs = [
      run({ id: 'a', summary: { passed: 2, failed: 1, errored: 1 } }),
      run({ id: 'b', status: 'running', summary: null }),
      run({ id: 'c', status: 'failed', summary: {} }),
      run({ id: 'd', status: 'odd', base_url: 'not a url', summary: null }),
    ];
    const { calls } = await setup({ client: fakeClient({ runs }), answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => !!view().querySelector('table'), 'the table');
    expect(calls[0]).toBe('runs select id, base_url, status, created_at, summary limit 50');
    expect(view().querySelector('caption')?.textContent).toBe('Your 4 runs, newest first');
    const rows = [...view().querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(rows[0].slice(1)).toEqual(['preview.vercel.app', 'Finished', '2 passed, 1 failed, 1 error']);
    expect(rows[1].slice(2)).toEqual(['Running', '—']);
    expect(rows[2].slice(2)).toEqual(['Failed', 'No results']);
    expect(rows[3].slice(1)).toEqual(['not a url', 'odd', '—']);
    expect(view().querySelector('tbody a')?.getAttribute('href')).toBe('#/runs/a');
  });

  it('says "50 latest" when the list is full', async () => {
    const runs = Array.from({ length: 50 }, (_, i) => run({ id: `r${i}` }));
    await setup({ client: fakeClient({ runs }), answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => !!view().querySelector('caption'), 'the caption');
    expect(view().querySelector('caption')?.textContent).toBe('Your 50 latest, newest first');
  });

  it('shows when the runs cannot be loaded, and refreshes the list on request', async () => {
    await setup({ client: fakeClient({ runsError: 'boom' }), answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => alertText().includes('boom'), 'the error');
    expect(view().textContent).toMatch(/Your runs could not be loaded\./);
    (view().querySelector('.toolbar button') as HTMLButtonElement).click();
    await until(() => statusText() === 'The list is up to date.', 'the refresh');
  });

  it('when the journeys cannot be loaded, says so and tries again', async () => {
    await setup({ answers: { 'GET /journeys': [{ status: 500, body: { error: 'down' } }, { status: 200, body: CATALOG }] } });
    await until(() => alertText().includes('down'), 'the error');
    expect(view().textContent).toMatch(/The journeys could not be loaded from the server\./);
    const retry = [...view().querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    retry.click();
    await until(() => !!document.getElementById('base-url'), 'the form');
  });

  it('checks the form, then queues the run with the token and goes to it', async () => {
    const { requests } = await setup({
      answers: {
        'GET /journeys': { status: 200, body: CATALOG },
        'POST /runs': { status: 201, body: { run: { id: RUN_ID } } },
        [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run() } },
      },
    });
    await until(() => !!document.getElementById('base-url'), 'the form');
    const form = view().querySelector('form')!;
    for (const id of ['mode-walker', 'mode-virtual']) (document.getElementById(id) as HTMLInputElement).checked = false;
    form.requestSubmit();
    expect(alertText()).toMatch(/There are 3 problems/);
    expect(document.getElementById('base-url')!.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement?.id).toBe('base-url');

    (document.getElementById('base-url') as HTMLInputElement).value = ' https://preview.vercel.app ';
    form.requestSubmit();
    expect(alertText()).toMatch(/There are 2 problems/);
    expect(document.activeElement?.id).toBe('journey-0');
    (document.getElementById('journey-0') as HTMLInputElement).checked = true;
    form.requestSubmit();
    expect(alertText()).toMatch(/There is a problem.*Choose at least one mode/);
    expect(document.getElementById('base-url')!.hasAttribute('aria-invalid')).toBe(false);
    (document.getElementById('mode-walker') as HTMLInputElement).checked = true;
    form.requestSubmit();
    form.requestSubmit(); // a second press while it is sending is ignored
    await until(() => window.location.hash === `#/runs/${RUN_ID}`, 'the run page');
    const posted = requests.filter((r) => r.method === 'POST');
    expect(posted).toEqual([{ path: '/runs', method: 'POST', body: { base_url: 'https://preview.vercel.app', journeys: [HOME], modes: ['walker'] }, auth: 'Bearer token-a' }]);
    expect(localStorage.getItem(BASE_URL_KEY)).toBe('https://preview.vercel.app');
  });

  it("shows the server's field errors, and its other errors", async () => {
    await setup({
      answers: {
        'GET /journeys': { status: 200, body: CATALOG },
        'POST /runs': [
          { status: 400, body: { error: 'bad', errors: [{ field: 'base_url', message: 'Not an allowed site.' }, { message: 'Something else.' }] } },
          { status: 429, body: { error: 'You already have 3 runs waiting or running.' } },
          { status: 502 },
          new TypeError('offline'),
        ],
      },
    });
    await until(() => !!document.getElementById('base-url'), 'the form');
    (document.getElementById('base-url') as HTMLInputElement).value = 'https://evil.example';
    (document.getElementById('journey-0') as HTMLInputElement).checked = true;
    const form = view().querySelector('form')!;
    const submitOnce = async (expected: RegExp) => {
      form.requestSubmit();
      await until(() => expected.test(alertText()), String(expected));
    };
    await submitOnce(/There are 2 problems.*Not an allowed site\..*Something else\./);
    expect(document.getElementById('base-url-error')!.textContent).toBe('Not an allowed site. Something else.');
    await submitOnce(/You already have 3 runs/);
    await submitOnce(/The server answered 502/);
    await submitOnce(/Could not reach the server/);
  });

  it('remembers the last address, and copes without storage', async () => {
    localStorage.setItem(BASE_URL_KEY, 'https://kept.vercel.app');
    document.body.innerHTML = body;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await setup({ answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => !!document.getElementById('base-url'), 'the form');
    expect((document.getElementById('base-url') as HTMLInputElement).value).toBe('');
    getItem.mockRestore();
  });

  it('signs out when the API says the session ended', async () => {
    const { signOut } = await setup({
      answers: { 'GET /journeys': { status: 200, body: CATALOG }, 'POST /runs': { status: 401, body: { error: 'Sign in first' } } },
    });
    await until(() => !!document.getElementById('base-url'), 'the form');
    (document.getElementById('base-url') as HTMLInputElement).value = 'https://preview.vercel.app';
    (document.getElementById('journey-0') as HTMLInputElement).checked = true;
    view().querySelector('form')!.requestSubmit();
    await until(() => signOut.mock.calls.length === 1, 'the sign-out');
    await until(() => view().textContent!.includes('Sign in at the top'), 'the signed-out view');
  });

  it('follows a run until it finishes, then offers its reports and announces the result', async () => {
    const { calls } = await setup({
      hash: `#/runs/${RUN_ID}`,
      answers: {
        'GET /journeys': { status: 200, body: CATALOG },
        [`GET /runs/${RUN_ID}`]: [
          { status: 200, body: { run: run({ status: 'queued', summary: null, run_results: [], started_at: null, finished_at: null }) } },
          { status: 503, body: { error: 'restarting' } },
          { status: 200, body: { run: run({ status: 'running', summary: null, run_results: [], finished_at: null }) } },
          { status: 200, body: { run: run({ summary: { passed: 1, files: ['home-page-tab-order.walker.md', 'summary.md'], skipped_files: ['huge.json'], skipped_count: 3, blocked_requests: ['10.0.0.1:80 (private)'] } }) } },
        ],
      },
    });
    expect(view().textContent).toMatch(/Results appear here when the run finishes/);
    expect(document.getElementById('sleep-note')!.textContent).toMatch(/takes about a minute to wake.*goes back in the queue/);
    await until(() => statusText().startsWith('The run finished'), 'the end');
    expect(statusText()).toBe('The run finished: 1 passed, 0 failed, 0 errors.');
    expect(view().querySelector('h1')?.textContent).toBe('Run on preview.vercel.app');
    expect(document.title).toBe('Run on preview.vercel.app – Screen Reader Journeys');
    // Only the names and types to draw the page; no report body yet.
    expect(calls.filter((c) => c.startsWith('reports'))).toEqual([`reports path, content_type ${RUN_ID} home-page-tab-order.walker.md,summary.md`]);
    const button = [...view().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Download'))!;
    expect(button.textContent).toBe('Download the report for Home page: Tab order, Keyboard walker');
    expect(view().textContent).not.toMatch(/The server sleeps/);
    expect(view().textContent).toMatch(/Files not kept.*too large, too many, a name or type a report cannot have, or saving took too long.*huge\.json.*And 2 more\./);
    expect(view().textContent).toMatch(/Blocked requests.*10\.0\.0\.1:80/);
    expect(view().textContent).toMatch(/2 of 2.*1 error, 0 warnings/);
  });

  it('fetches a report only when asked, and saves it as a download, never as a page', async () => {
    const created: Blob[] = [];
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockImplementation((blob: Blob) => {
      created.push(blob);
      return 'blob:report';
    });
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href')!, download: this.getAttribute('download')! });
    });
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    const { calls } = await setup({ hash: `#/runs/${RUN_ID}`, answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ summary: { files: ['summary.html', 'gone.md'] } }) } } } });
    const buttons = [...view().querySelectorAll<HTMLButtonElement>('.files button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['summary.html']);
    expect(view().textContent).toMatch(/gone\.md/);
    buttons[0].click();
    await until(() => clicked.length === 1, 'the download');
    expect(calls.at(-1)).toBe(`reports path, body ${RUN_ID} summary.html`);
    expect(clicked[0]).toEqual({ href: 'blob:report', download: 'summary.html' });
    expect(created[0].type).toBe('application/octet-stream');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]);
    });
    expect(text).toContain('<script>');
    expect(document.querySelectorAll('a[hidden]')).toHaveLength(0);
    await until(() => statusText() === 'Downloaded summary.html.', 'the announcement');
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report');
    vi.useRealTimers();
    click.mockRestore();
  });

  it('says when a report cannot be downloaded', async () => {
    const client = fakeClient();
    await setup({ hash: `#/runs/${RUN_ID}`, client, answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ summary: { files: ['summary.md'] } }) } } } });
    const original = client.client.from;
    (client.client as { from: unknown }).from = (table: string) =>
      table === 'run_reports' ? { select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) } : (original as (t: string) => unknown)(table);
    [...view().querySelectorAll<HTMLButtonElement>('.files button')][0].click();
    await until(() => alertText().includes('The report could not be downloaded: it is no longer there'), 'the error');
  });

  it('stops polling a run when the person signs out, even with an answer still on its way (R2.6)', async () => {
    let release: () => void = () => {};
    let answered: () => void = () => {};
    const heldAnswerRead = new Promise<void>((resolve) => (answered = resolve));
    const { fetch, signIn } = await setup({
      hash: `#/runs/${RUN_ID}`,
      answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ status: 'running', summary: null, run_results: [] }) } } },
    });
    const reads = () => fetch.mock.calls.filter(([url]) => String(url).endsWith(`/runs/${RUN_ID}`)).length;
    // Hold the next answer until after the sign-out, and know when the page has read it.
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (!String(url).endsWith(`/runs/${RUN_ID}`)) return original(url, init);
      await new Promise<void>((resolve) => (release = resolve));
      const response = await original(url, init);
      const json = response.json.bind(response);
      response.json = async () => {
        const body = await json();
        answered();
        return body;
      };
      return response;
    });
    await until(() => reads() === 2, 'the second poll');
    signIn(null);
    await until(() => view().textContent!.includes('Sign in at the top'), 'the signed-out view');
    // From here, a poll would show as a timer for refresh: count every timer the page sets.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    release();
    await heldAnswerRead;
    // Let the page finish with that answer: everything queued before this macrotask runs first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.mock.calls.filter(([, ms]) => ms === 5 || ms === 10)).toEqual([]);
    expect(reads()).toBe(2);
    expect(view().textContent).toMatch(/Sign in at the top/);
    timers.mockRestore();
  });

  it('shows a failed run, and one with no results', async () => {
    await setup({
      hash: `#/runs/${RUN_ID}`,
      answers: { 'GET /journeys': { status: 500 }, [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ status: 'failed', error: 'Refused: evil.example', run_results: [], summary: null, journeys: ['targets/unknown.journey.js'], modes: ['oddmode'] }) } } },
    });
    expect(view().textContent).toMatch(/Problem.*Refused: evil\.example/);
    expect(view().textContent).toMatch(/This run has no results\./);
    expect(view().textContent).toMatch(/targets\/unknown\.journey\.js/);
    expect(view().textContent).toMatch(/oddmode/);
  });

  it('says when a run is not there, or cannot be loaded', async () => {
    await setup({ hash: `#/runs/${RUN_ID}`, answers: {} });
    expect(view().textContent).toMatch(/There is no such run, or it is not yours\./);
    await setup({ hash: `#/runs/${RUN_ID}`, answers: { [`GET /runs/${RUN_ID}`]: new TypeError('offline') } });
    expect(view().textContent).toMatch(/The run could not be loaded\./);
  });

  it('still shows a run when its reports cannot be loaded', async () => {
    await setup({ hash: `#/runs/${RUN_ID}`, client: fakeClient({ reportsError: 'denied' }), answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ run_results: [{ ...run().run_results![0], report_path: null, status: 'weird' }] }) } } } });
    expect(alertText()).toMatch(/The reports could not be loaded: denied/);
    expect(view().textContent).toMatch(/Downloads.*summary\.md/);
  });

  it('deletes a finished run after asking, and not without', async () => {
    const declined = await setup({ hash: `#/runs/${RUN_ID}`, confirm: false, answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ summary: null }) } } } });
    const button = () => [...view().querySelectorAll('button')].find((b) => b.textContent === 'Delete this run')!;
    button().click();
    await tick();
    expect(declined.calls.some((c) => c.startsWith('runs delete'))).toBe(false);

    const failing = await setup({ hash: `#/runs/${RUN_ID}`, client: fakeClient({ deleteError: 'nope' }), answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run() } } } });
    button().click();
    await until(() => alertText().includes('The run could not be deleted: nope'), 'the error');
    expect(failing.calls).toContain(`runs delete ${RUN_ID}`);

    await setup({ hash: `#/runs/${RUN_ID}`, answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run() } } } });
    button().click();
    await until(() => window.location.hash === '#/', 'the list');
    await until(() => statusText() === 'The run is deleted.', 'the announcement');
  });

  it('offers no delete while a run is waiting or running', async () => {
    await setup({ hash: `#/runs/${RUN_ID}`, answers: { [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run({ status: 'running', summary: null, run_results: [] }) } } } });
    expect(view().textContent).not.toMatch(/Delete this run/);
  });

  it('follows the address, and leaves hashes that are not routes to the browser', async () => {
    await setup({ answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run() } } } });
    window.location.hash = `#/runs/${RUN_ID}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await until(() => view().querySelector('h1')?.textContent === 'Run on preview.vercel.app', 'the run');
    expect(document.activeElement).toBe(view().querySelector('h1'));
    window.location.hash = '#main';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await tick();
    expect(view().querySelector('h1')?.textContent).toBe('Run on preview.vercel.app');
  });

  it('switches views when the person signs in or out', async () => {
    const { signIn } = await setup({ session: null, answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    signIn(SESSION);
    await until(() => view().querySelector('h1')?.textContent === 'Runs', 'the runs');
    signIn({ ...SESSION, access_token: 'refreshed' } as Session); // a refreshed token changes nothing
    await tick(5);
    expect(view().querySelector('h1')?.textContent).toBe('Runs');
    signIn(null);
    await until(() => view().querySelector('h1')?.textContent === 'Screen Reader Journeys', 'the signed-out view');
  });

  it('makes a wide table a scrollable, labelled region only while it overflows', async () => {
    let observed: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
      },
    );
    await setup({ client: fakeClient({ runs: [run()] }), answers: { 'GET /journeys': { status: 200, body: CATALOG } } });
    await until(() => !!view().querySelector('.table-scroll'), 'the table');
    const wrap = view().querySelector('.table-scroll') as HTMLElement;
    Object.defineProperty(wrap, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(wrap, 'clientWidth', { value: 300, configurable: true });
    observed!();
    expect([wrap.getAttribute('role'), wrap.getAttribute('tabindex'), wrap.getAttribute('aria-label')]).toEqual(['region', '0', 'Your 1 run, newest first']);
    Object.defineProperty(wrap, 'scrollWidth', { value: 300, configurable: true });
    observed!();
    expect(wrap.hasAttribute('role')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('progress while a run is going (the owner: "The run is running." says too little)', () => {
  const progress = (fields: Partial<Progress> = {}): Progress => ({
    journey: HOME,
    mode: 'walker',
    step: 'press Tab',
    n: 5,
    index: 2,
    of: 4,
    done: 1,
    passed: 1,
    failed: 0,
    errored: 0,
    started_at: new Date(Date.now() - 80_000).toISOString(),
    time_limit_s: 900,
    ...fields,
  });
  const running = { status: 200, body: { run: run({ status: 'running', summary: null, run_results: [], finished_at: null }) } };
  const box = () => document.getElementById('progress')?.textContent ?? '';
  /** Every non-empty text the status line takes, in order. */
  const announcements = () => {
    const seen: string[] = [];
    new MutationObserver(() => {
      const text = statusText();
      if (text) seen.push(text);
    }).observe(document.getElementById('status')!, { childList: true, characterData: true, subtree: true });
    return seen;
  };

  it('shows which journey and mode, the results so far, the step and the time, and says the first two', async () => {
    await setup({ hash: `#/runs/${RUN_ID}`, answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: running, [`GET /runs/${RUN_ID}/progress`]: { status: 200, body: { progress: progress() } } } });
    await until(() => box().includes('Running'), 'the progress');
    expect(box()).toMatch(/Running 2 of 4: Home page: Tab order, Keyboard walker\./);
    expect(box()).toMatch(/So far: 1 passed, 0 failed, 0 errors\./);
    expect(box()).toMatch(/Step 5: press Tab/);
    expect(box()).toMatch(/1 min 2\d s of 15 min\./);
    await until(() => statusText().startsWith('Running'), 'the announcement');
    expect(statusText()).toBe('Running 2 of 4: Home page: Tab order, Keyboard walker. So far: 1 passed, 0 failed, 0 errors.');
  });

  it('says it again only when the journey or the results change, never for a step or the clock', async () => {
    // Polls here come every 5 ms and an announcement lands after 50 ms, so each state lasts for
    // a few dozen polls: the steps change, the journey and results stay the same.
    const steps = [
      ...Array.from({ length: 30 }, (_, i) => progress({ step: i % 2 ? 'press Tab' : 'press Enter', n: i + 1 })),
      progress({ index: 3, done: 2, passed: 1, failed: 1, journey: 'targets/x/other.journey.js', step: null, n: null }),
    ];
    const ui = setup({ hash: `#/runs/${RUN_ID}`, answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: running, [`GET /runs/${RUN_ID}/progress`]: steps.map((p) => ({ status: 200, body: { progress: p } })) } });
    const seen = announcements();
    await ui;
    await until(() => box().includes('Running 3 of 4'), 'the third journey');
    await until(() => seen.length >= 2, 'two announcements');
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toEqual([
      'Running 2 of 4: Home page: Tab order, Keyboard walker. So far: 1 passed, 0 failed, 0 errors.',
      'Running 3 of 4: Other, Keyboard walker. So far: 1 passed, 1 failed, 0 errors.',
    ]);
  });

  it('shows nothing when the server has no progress for the run', async () => {
    const ui = await setup({ hash: `#/runs/${RUN_ID}`, answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: running, [`GET /runs/${RUN_ID}/progress`]: { status: 200, body: { progress: null } } } });
    await until(() => ui.requests.some((r) => r.path.endsWith('/progress')), 'a progress request');
    await new Promise((r) => setTimeout(r, 20));
    expect(box()).toBe('');
  });

  it('asks for progress only while the run is running', async () => {
    const ui = await setup({ hash: `#/runs/${RUN_ID}`, answers: { 'GET /journeys': { status: 200, body: CATALOG }, [`GET /runs/${RUN_ID}`]: { status: 200, body: { run: run() } } } });
    await until(() => !!document.querySelector('#status-heading'), 'the run');
    await new Promise((r) => setTimeout(r, 30));
    expect(ui.requests.some((r) => r.path.endsWith('/progress'))).toBe(false);
  });

  it('writes durations the way people say them', () => {
    expect(duration(45)).toBe('45 s');
    expect(duration(80)).toBe('1 min 20 s');
    expect(duration(900)).toBe('15 min');
    expect(duration(-3)).toBe('0 s');
  });
});
