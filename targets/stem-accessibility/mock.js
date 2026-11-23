// A fake STEM-Accessibility backend, answered inside the browser. Journeys run against any
// frontend (a local dev server or a pull request's Vercel preview) without touching a real
// backend: the page's API calls for the shared image below never leave the browser.

import { readFileSync } from "node:fs";

const sharedFlowchart = JSON.parse(readFileSync(new URL("./fixtures/shared-flowchart.json", import.meta.url), "utf8"));

/** The shared page for the fixture image. The slug does not exist on any real backend. */
export const SHARED_IMAGE_PATH = `/p/${sharedFlowchart.public_slug}`;

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  headers: { "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

/**
 * Answer `GET <api>/p/<slug>` with the fixture and `GET <api>/p/<slug>/image` with "no image",
 * whatever host the frontend uses for its API. The page itself (also `/p/<slug>`, but a document
 * request) still loads from the frontend.
 */
export async function mockSharedImage(page, data = sharedFlowchart) {
  const slug = data.public_slug;
  await page.route(
    (url) => url.pathname === `/p/${slug}` || url.pathname === `/p/${slug}/image`,
    (route) => {
      const request = route.request();
      if (!["fetch", "xhr"].includes(request.resourceType())) return route.continue();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
      const path = new URL(request.url()).pathname;
      return route.fulfill(path.endsWith("/image") ? json({ error: "No image" }, 404) : json(data));
    }
  );
}
