// An in-memory stand-in for the parts of supabase-js the server uses: auth.getUser, rpc (the
// worker_* functions of supabase/migrations/0001_runs.sql, which check the worker token), and
// from(table) with select/insert/update/eq/lt/in/single/maybeSingle. `asUser(id)` gives a
// client that behaves roughly like row-level security for that user. Every call is recorded in
// `calls`.

import { randomUUID } from "node:crypto";

class Query {
  constructor(fake, table, user) {
    Object.assign(this, { fake, table, user, op: "select", values: null, filters: [], shape: "many", embed: false });
  }
  select(columns = "*") {
    this.embed = /run_results\(/.test(columns);
    return this;
  }
  insert(values) {
    this.op = "insert";
    this.values = values;
    return this;
  }
  update(values) {
    this.op = "update";
    this.values = values;
    return this;
  }
  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  lt(column, value) {
    this.filters.push((row) => row[column] != null && row[column] < value);
    return this;
  }
  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  single() {
    this.shape = "single";
    return this;
  }
  maybeSingle() {
    this.shape = "maybe";
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }

  visible(row) {
    if (!this.user) return true;
    return row.user_id === this.user;
  }

  result(rows) {
    const copy = rows.map((row) => structuredClone(row));
    if (this.embed) for (const row of copy) row.run_results = this.fake.tables.run_results.filter((r) => r.run_id === row.id).map((r) => structuredClone(r));
    if (this.shape === "single") return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
    if (this.shape === "maybe") return { data: copy[0] ?? null, error: null };
    return { data: copy, error: null };
  }

  run() {
    this.fake.calls.push({ op: this.op, table: this.table, values: structuredClone(this.values), user: this.user });
    const injected = this.fake.failures.findIndex((f) => f.op === this.op && f.table === this.table);
    if (injected >= 0) return { data: null, error: this.fake.failures.splice(injected, 1)[0].error };
    const rows = this.fake.tables[this.table];
    if (this.op === "insert") {
      const list = [].concat(this.values).map((values) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...values }));
      if (this.user && this.table !== "runs") return { data: null, error: { code: "42501", message: "permission denied" } };
      if (this.user && list.some((row) => row.user_id !== this.user || row.status !== "queued")) {
        return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
      }
      rows.push(...list);
      return this.result(list);
    }
    const matched = rows.filter((row) => this.visible(row) && this.filters.every((f) => f(row)));
    if (this.op === "update") {
      if (this.user) return { data: null, error: { code: "42501", message: "permission denied" } };
      for (const row of matched) Object.assign(row, structuredClone(this.values));
    }
    return this.result(matched);
  }
}

export const WORKER_TOKEN = "worker-token-for-tests-0123456789abcdef";

export function fakeSupabase({ runs = [], users = {}, workerToken = WORKER_TOKEN } = {}) {
  const now = () => new Date().toISOString();
  const running = (id) => fake.tables.runs.find((r) => r.id === id && r.status === "running");
  // The worker_* functions: what each does in the database, in a few lines.
  const functions = {
    worker_claim_next_run() {
      const run = fake.tables.runs.filter((r) => r.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (!run) return [];
      Object.assign(run, { status: "running", started_at: now(), finished_at: null, error: null });
      return [structuredClone(run)];
    },
    worker_fail_stale_runs({ p_older_than_seconds }) {
      const cutoff = new Date(Date.now() - p_older_than_seconds * 1000).toISOString();
      const stale = fake.tables.runs.filter((r) => r.status === "running" && r.started_at < cutoff);
      for (const run of stale) Object.assign(run, { status: "failed", error: "The server stopped before this run finished.", finished_at: now() });
      return stale.length;
    },
    worker_prune_runs() {
      const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const old = fake.tables.runs.filter((r) => ["done", "failed"].includes(r.status) && r.finished_at && r.finished_at < cutoff);
      fake.tables.runs = fake.tables.runs.filter((r) => !old.includes(r));
      return old.length;
    },
    worker_requeue_run({ p_run_id }) {
      const run = running(p_run_id);
      if (run) Object.assign(run, { status: "queued", started_at: null });
      return Boolean(run);
    },
    worker_save_report({ p_run_id, p_path, p_content_type, p_body }) {
      const run = running(p_run_id);
      if (!run) return false;
      const reports = fake.tables.run_reports;
      const row = { run_id: p_run_id, user_id: run.user_id, path: p_path, content_type: p_content_type, body: p_body, created_at: now() };
      const at = reports.findIndex((r) => r.run_id === p_run_id && r.path === p_path);
      if (at >= 0) reports[at] = row;
      else reports.push(row);
      return true;
    },
    worker_add_results({ p_run_id, p_results }) {
      const run = running(p_run_id);
      if (!run) return 0;
      fake.tables.run_results.push(...p_results.map((r) => ({ id: randomUUID(), run_id: p_run_id, user_id: run.user_id, ...structuredClone(r) })));
      return p_results.length;
    },
    worker_finish_run({ p_run_id, p_status, p_error, p_summary }) {
      const run = running(p_run_id);
      if (run) Object.assign(run, { status: p_status, error: p_error, summary: structuredClone(p_summary), finished_at: now() });
      return Boolean(run);
    },
  };
  const fake = {
    tables: {
      runs: runs.map((run) => ({ status: "queued", created_at: now(), started_at: null, finished_at: null, error: null, summary: null, ...run })),
      run_results: [],
      run_reports: [],
    },
    calls: [],
    /** Make the next matching call fail: { op: "insert", table: "runs", error } or { op: "rpc", name, error }. */
    failures: [],
    auth: {
      async getUser(token) {
        const user = users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
    async rpc(name, args = {}) {
      fake.calls.push({ op: "rpc", name, args: structuredClone(args) });
      // As PostgREST: a text argument cannot hold U+0000.
      if (Object.values(args).some((v) => typeof v === "string" && v.includes("\u0000"))) {
        return { data: null, error: { code: "22P05", message: "unsupported Unicode escape sequence" } };
      }
      const injected = fake.failures.findIndex((f) => f.op === "rpc" && f.name === name);
      if (injected >= 0) return { data: null, error: fake.failures.splice(injected, 1)[0].error };
      if (!functions[name]) return { data: null, error: { message: `Could not find the function ${name}` } };
      if (args.p_token !== workerToken) return { data: null, error: { code: "42501", message: "Bad worker token." } };
      return { data: functions[name](args), error: null };
    },
    from: (table) => new Query(fake, table, null),
    /** A client acting as one user, with RLS-like visibility and insert rules. */
    asUser: (id) => ({ from: (table) => new Query(fake, table, id) }),
    run: (id) => fake.tables.runs.find((r) => r.id === id),
    report: (runId, path) => fake.tables.run_reports.find((r) => r.run_id === runId && r.path === path),
  };
  return fake;
}
