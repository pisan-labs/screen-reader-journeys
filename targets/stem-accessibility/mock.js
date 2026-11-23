// A fake STEM-Accessibility backend, answered inside the browser. Journeys run against any
// frontend (a local dev server or a pull request's Vercel preview) without touching a real
// backend: the page's API calls for the fixtures below never leave the browser. There is also a
// stand-in for speech synthesis, which headless browsers lack.

import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const sharedFlowchart = fixture("shared-flowchart.json");
/** A shared STEM image whose long description has math in it (`$…$` and `$$…$$`). */
export const sharedMathImage = fixture("shared-math.json");
/** A shared chart: a small data set with a time and a value column, for the sonification player. */
export const sharedChart = fixture("shared-chart.json");

/** The shared page for the fixture image. The slug does not exist on any real backend. */
export const SHARED_IMAGE_PATH = `/p/${sharedFlowchart.public_slug}`;
/** The shared page for the image with math. */
export const MATH_IMAGE_PATH = `/p/${sharedMathImage.public_slug}`;
/** The shared page for the fixture chart (the frontend's `/charts/:slug`; its API is `/c/:slug`). */
export const SHARED_CHART_PATH = `/charts/${sharedChart.slug}`;

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  headers: { "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

/**
 * Answer the page's API calls (fetch or XHR) to the given paths, on whatever host the frontend
 * uses for its API. A document request to the same path still loads from the frontend.
 */
async function answer(page, paths) {
  await page.route(
    (url) => Object.hasOwn(paths, url.pathname),
    (route) => {
      const request = route.request();
      if (!["fetch", "xhr"].includes(request.resourceType())) return route.continue();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
      return route.fulfill(paths[new URL(request.url()).pathname]());
    }
  );
}

/**
 * Answer `GET <api>/p/<slug>` with the fixture and `GET <api>/p/<slug>/image` with "no image".
 * The page itself (also `/p/<slug>`, but a document request) still loads from the frontend.
 */
export async function mockSharedImage(page, data = sharedFlowchart) {
  const slug = data.public_slug;
  await answer(page, {
    [`/p/${slug}`]: () => json(data),
    [`/p/${slug}/image`]: () => json({ error: "No image" }, 404),
  });
}

/** Answer `GET <api>/c/<slug>`, the data behind the shared chart page `/charts/<slug>`. */
export async function mockSharedChart(page, data = sharedChart) {
  const { slug, ...chart } = data;
  await answer(page, { [`/c/${slug}`]: () => json(chart) });
}

/**
 * A stand-in for the browser's speech synthesis. The sonification library (Erie) speaks an
 * introduction before the notes and waits for each utterance to end; headless browsers have no
 * voices, so speech fails and Erie would wait forever. This one takes about as long as a voice
 * (15 characters a second), ends an utterance when cancelled, and keeps what the site asked it
 * to say, for `siteSpeech(page)`.
 */
export async function mockSpeechSynthesis(page) {
  await page.addInitScript(() => {
    const said = [];
    const queue = [];
    let current = null;
    let timer = null;
    const end = (utterance) => utterance.dispatchEvent(new Event("end"));
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => [],
      speak(utterance) {
        queue.push(utterance);
        if (!current) this.next();
      },
      next() {
        current = queue.shift() ?? null;
        this.speaking = !!current;
        this.pending = queue.length > 0;
        if (!current) return;
        const utterance = current;
        said.push(utterance.text);
        setTimeout(() => utterance.dispatchEvent(new Event("start")), 0);
        timer = setTimeout(() => {
          end(utterance);
          this.next();
        }, 200 + utterance.text.length * 66);
      },
      cancel() {
        clearTimeout(timer);
        const utterances = [current, ...queue.splice(0)].filter(Boolean);
        current = null;
        this.speaking = this.pending = false;
        utterances.forEach(end);
      },
      pause() {},
      resume() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.__srjSiteSpeech = { take: () => said.splice(0) };
  });
}

/** What the site has said through speech synthesis since the last call (needs `mockSpeechSynthesis`). */
export async function siteSpeech(page) {
  return page.evaluate(() => window.__srjSiteSpeech?.take() ?? []);
}
