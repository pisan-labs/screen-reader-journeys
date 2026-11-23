// An in-memory stand-in for the parts of supabase-js the server uses: auth.getUser, rpc
// ("claim_next_run"), from(table) with select/insert/update/eq/lt/in/single/maybeSingle, and
// storage.from(bucket).upload. `asUser(id)` gives a client that behaves roughly like row-level
// security for that user. Every call is recorded in `calls`.

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
    if (this.table === "runs") return row.created_by === this.user;
    if (this.table === "run_results") return this.fake.tables.runs.some((r) => r.id === row.run_id && r.created_by === this.user);
    return false;
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
      if (this.user && list.some((row) => row.created_by !== this.user || row.status !== "queued")) {
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

export function fakeSupabase({ runs = [], users = {} } = {}) {
  const fake = {
    tables: { runs: runs.map((run) => ({ status: "queued", created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null, summary: null, ...run })), run_results: [] },
    uploads: new Map(),
    calls: [],
    /** Make the next matching call fail: { op: "insert", table: "runs", error: { code, message } }. */
    failures: [],
    auth: {
      async getUser(token) {
        const user = users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
    async rpc(name) {
      fake.calls.push({ op: "rpc", name });
      if (name !== "claim_next_run") return { data: null, error: { message: `no function ${name}` } };
      const run = fake.tables.runs.filter((r) => r.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (!run) return { data: [], error: null };
      Object.assign(run, { status: "running", started_at: new Date().toISOString() });
      return { data: [structuredClone(run)], error: null };
    },
    from: (table) => new Query(fake, table, null),
    storage: {
      from: (bucket) => ({
        async upload(path, body, options) {
          fake.calls.push({ op: "upload", bucket, path, options });
          fake.uploads.set(`${bucket}/${path}`, { body: Buffer.from(body), options });
          return { data: { path }, error: null };
        },
      }),
    },
    /** A client acting as one user, with RLS-like visibility and insert rules. */
    asUser: (id) => ({ from: (table) => new Query(fake, table, id) }),
    run: (id) => fake.tables.runs.find((r) => r.id === id),
  };
  return fake;
}
