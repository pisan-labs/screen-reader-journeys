// Start Chromium once with its sandbox, as the run's user, and say whether it worked. The worker
// runs this at start-up when ALLOWED_TARGET_HOSTS is "*" (worker.js, start): any signed-in person
// may then point the browser at any page, so a page that exploits Chromium must meet the
// sandbox, not only the network guard, which a process of the run's user could go around.
//
// Exits 0 if a sandboxed Chromium opened a page, 1 with the reason's first line on stdout if not.

import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

export async function probe({ launch = (options) => chromium.launch(options) } = {}) {
  const browser = await launch({ chromiumSandbox: true, timeout: 20000 });
  try {
    const page = await browser.newPage();
    await page.setContent("<p>sandboxed</p>");
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  probe().then(
    () => process.exit(0),
    (error) => {
      process.stdout.write(`${String(error?.message ?? error).split("\n")[0].slice(0, 500)}\n`);
      process.exit(1);
    }
  );
}
