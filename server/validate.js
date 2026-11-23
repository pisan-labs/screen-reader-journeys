// Validate a request to start a run. The API checks it before inserting, and the worker checks
// it again before running, because a signed-in user can also insert a queued run directly
// through Supabase.

import { findJourney } from "./catalog.js";
import { checkTargetUrl } from "./hosts.js";

/** The modes the server runs. voiceover needs a Mac and orca a desktop session, so they stay with the CLI. */
export const SERVER_MODES = Object.freeze(["walker", "virtual"]);

const clip = (value) => {
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

/**
 * Returns `{ ok: true, value: { base_url, journeys, modes } }` with normalized values, or
 * `{ ok: false, errors: [{ field, message }] }`.
 */
export function validateRunRequest(body, { catalog, rules, modes = SERVER_MODES }) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: null, message: "Send a JSON object with base_url, journeys and modes." }] };
  }

  const target = checkTargetUrl(body.base_url, rules);
  if (!target.ok) add("base_url", target.reason);

  const journeys = [];
  if (!Array.isArray(body.journeys) || body.journeys.length === 0) {
    add("journeys", "Choose at least one journey.");
  } else if (body.journeys.length > catalog.length) {
    add("journeys", `Choose at most ${catalog.length} journeys.`);
  } else {
    for (const path of body.journeys) {
      if (!findJourney(catalog, path)) {
        add("journeys", `"${clip(path)}" is not one of this server's journeys. GET /journeys lists them.`);
        break;
      }
      if (!journeys.includes(path)) journeys.push(path);
    }
  }

  const chosen = [];
  if (!Array.isArray(body.modes) || body.modes.length === 0) {
    add("modes", "Choose at least one mode.");
  } else {
    for (const mode of body.modes) {
      if (!modes.includes(mode)) {
        add("modes", `"${clip(mode)}" is not a mode this server runs. It runs ${modes.join(" and ")}; voiceover needs a Mac.`);
        break;
      }
      if (!chosen.includes(mode)) chosen.push(mode);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { base_url: target.url, journeys, modes: chosen } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID.test(value);
