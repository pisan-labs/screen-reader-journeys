// The HTTP API. Plain node:http, JSON in and out.
//
//   GET  /health      liveness
//   GET  /journeys    the journeys and modes this server runs, and the sites it may test
//   POST /runs        queue a run (signed in): { base_url, journeys: [path], modes: [mode] }
//   GET  /runs/:id    a run and its results (signed in, your own runs only)
//
// `auth.getUser(jwt)` verifies a Supabase access token (supabase.auth from an anon-key client).
// `userClient(jwt)` returns a Supabase client that acts as that user, so row-level security
// decides what they may read and insert.

import { SERVER_MODES, isUuid, validateRunRequest } from "./validate.js";

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      reject(new HttpError(415, "Send the body as JSON (Content-Type: application/json)."));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop keeping the body; the 413 closes the connection.
        req.off("data", onData);
        req.resume();
        reject(new HttpError(413, "The request body is too large."));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "The body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

const byJourneyAndMode = (a, b) => a.journey.localeCompare(b.journey) || a.mode.localeCompare(b.mode);

export function createHandler({ config, catalog, auth, userClient, version = "dev", log = console }) {
  const journeyList = catalog.map(({ path, name, description }) => ({ path, name, description }));

  async function authenticate(req) {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? "");
    if (!match || match[1].length > 8192) return null;
    try {
      const { data, error } = await auth.getUser(match[1]);
      if (error || !data?.user?.id) return null;
      return { user: data.user, token: match[1] };
    } catch {
      return null;
    }
  }

  async function signedIn(req) {
    const who = await authenticate(req);
    if (!who) throw new HttpError(401, 'Sign in first, then send your Supabase access token as "Authorization: Bearer <token>".');
    return who;
  }

  async function createRun(req) {
    const who = await signedIn(req);
    const check = validateRunRequest(await readJson(req), { catalog, rules: config.targetRules });
    if (!check.ok) return [400, { error: check.errors.map((e) => e.message).join(" "), errors: check.errors }];
    const { data, error } = await userClient(who.token)
      .from("runs")
      .insert({ created_by: who.user.id, status: "queued", ...check.value })
      .select()
      .single();
    if (error) {
      // 53400: the database's limit on runs waiting or running per user.
      if (error.code === "53400") return [429, { error: error.message }];
      log.error(`insert run: ${error.code ?? ""} ${error.message}`);
      if (error.code === "42501") return [403, { error: "The database refused this run." }];
      return [502, { error: "The run could not be saved. Try again in a moment." }];
    }
    return [201, { run: data }, { Location: `/runs/${data.id}` }];
  }

  async function getRun(req, id) {
    const who = await signedIn(req);
    if (!isUuid(id)) return [404, { error: "No such run." }];
    const { data, error } = await userClient(who.token).from("runs").select("*, run_results(*)").eq("id", id).maybeSingle();
    if (error) {
      log.error(`read run: ${error.code ?? ""} ${error.message}`);
      return [502, { error: "The run could not be read. Try again in a moment." }];
    }
    if (!data) return [404, { error: "No such run, or it is not yours." }];
    data.run_results = [...(data.run_results ?? [])].sort(byJourneyAndMode);
    return [200, { run: data }];
  }

  const routes = [
    { path: /^\/health$/, GET: () => [200, { status: "ok", version }] },
    { path: /^\/journeys$/, GET: () => [200, { journeys: journeyList, modes: SERVER_MODES, allowed_hosts: config.targetRules.map((r) => r.text) }] },
    { path: /^\/runs$/, POST: (req) => createRun(req) },
    { path: /^\/runs\/([^/]+)$/, GET: (req, id) => getRun(req, id) },
  ];

  return async function handle(req, res) {
    const origin = req.headers.origin;
    const cors = origin && config.allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin } : {};
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin",
        ...cors,
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname.replace(/(.)\/+$/, "$1");
      const route = routes.find((r) => r.path.test(path));
      if (req.method === "OPTIONS") {
        if (!route || !cors["Access-Control-Allow-Origin"]) return send(403, { error: "This origin may not call the API (ALLOWED_ORIGINS)." });
        res.writeHead(204, {
          ...cors,
          Vary: "Origin",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      if (!route) return send(404, { error: "Not found." });
      const action = route[req.method === "HEAD" ? "GET" : req.method];
      if (!action) return send(405, { error: "Method not allowed." }, { Allow: ["GET", "POST"].filter((m) => route[m]).join(", ") });
      const [status, body, headers] = await action(req, ...route.path.exec(path).slice(1));
      return send(status, body, headers);
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message }, error.status === 413 ? { Connection: "close" } : {});
      log.error(`${req.method} ${req.url}: ${error.stack ?? error}`);
      return send(500, { error: "Something went wrong on the server." });
    }
  };
}
