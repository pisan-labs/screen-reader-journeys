// The journeys this server will run: the *.journey.js files in its own checkout. Users choose
// from this list by path; the server never runs code a user sends.

import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJourney } from "../src/journey.js";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Load every journey under `dirs` (relative to `root`). Returns a frozen list of
 * `{ path, file, name, description }`, where `path` is repo-relative with forward slashes,
 * e.g. "targets/generic/home-tab-order.journey.js".
 */
export async function loadCatalog({ root = REPO_ROOT, dirs = ["targets"] } = {}) {
  const entries = [];
  for (const dir of dirs) {
    const full = resolve(root, dir);
    for (const entry of await readdir(full, { recursive: true })) {
      if (!entry.endsWith(".journey.js")) continue;
      const file = join(full, entry);
      const journey = await loadJourney(file);
      entries.push(
        Object.freeze({
          path: relative(root, file).split(sep).join("/"),
          file,
          name: journey.name,
          description: journey.description ?? "",
        })
      );
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return Object.freeze(entries);
}

/** Look up a journey by its exact repo-relative path; no normalization, so "../" tricks cannot match. */
export function findJourney(catalog, path) {
  return typeof path === "string" ? catalog.find((j) => j.path === path) ?? null : null;
}
