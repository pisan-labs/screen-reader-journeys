// The worker's only way into the database: the worker_* functions in the app's schema
// (supabase/migrations/0001_runs.sql), called with the public anon key and WORKER_TOKEN. Each
// function checks the token's SHA-256 against the one pinned in worker_config. There is no
// service-role key.

export const SCHEMA = "app_screen_reader_journeys";

/**
 * `client` is a supabase-js client made with the anon key and `db: { schema: SCHEMA }` (or a fake
 * with the same `rpc` method, in the tests). Every method throws on a database error, with the
 * function's name in the message.
 */
export function workerDb(client, token) {
  async function call(fn, args = {}) {
    const { data, error } = await client.rpc(fn, { p_token: token, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  }

  return {
    /** Fail runs still running that started more than `seconds` ago. Resolves to how many. */
    failStaleRuns: (seconds) => call("worker_fail_stale_runs", { p_older_than_seconds: Math.max(60, Math.ceil(seconds)) }),

    /** Claim the oldest queued run and mark it running. Resolves to the run, or null. */
    async claim() {
      const data = await call("worker_claim_next_run");
      return (Array.isArray(data) ? data[0] : data) ?? null;
    },

    /** Put a running run back in the queue. */
    requeue: (runId) => call("worker_requeue_run", { p_run_id: runId }),

    /** Save one report file. Resolves to false when the run is no longer running. */
    saveReport: (runId, path, contentType, body) =>
      call("worker_save_report", { p_run_id: runId, p_path: path, p_content_type: contentType, p_body: body }),

    /** Record results: [{ journey, mode, status, checks_passed, checks_total, errors, warnings, report_path }]. */
    addResults: (runId, rows) => call("worker_add_results", { p_run_id: runId, p_results: rows }),

    /** Finish a running run: { status: "done" | "failed", error, summary }. */
    finish: (runId, { status, error = null, summary = null }) =>
      call("worker_finish_run", { p_run_id: runId, p_status: status, p_error: error, p_summary: summary }),
  };
}
