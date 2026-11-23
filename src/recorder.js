// Runs inside the page (added with context.addInitScript) before the app's own scripts.
// It records what live regions would announce: text that changes inside role="status",
// role="alert", role="log" or aria-live="polite|assertive". Screen readers differ in the details
// (aria-atomic, aria-relevant, timing), so this is an approximation: it reports the region's
// whole text after each change, with its politeness.

export function installRecorder() {
  if (window.__srj) return;
  const start = performance.now();
  const announcements = [];
  const lastText = new WeakMap();

  const liveRegionOf = (element) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const live = node.getAttribute("aria-live");
      if (live === "off") return null;
      if (live === "polite" || live === "assertive") return { node, politeness: live };
      const role = node.getAttribute("role");
      if (role === "alert") return { node, politeness: "assertive" };
      if (role === "status" || role === "log") return { node, politeness: "polite" };
    }
    return null;
  };

  const observer = new MutationObserver((records) => {
    const changed = new Map();
    const note = (node) => {
      const element = node && (node.nodeType === 1 ? node : node.parentElement);
      const region = element && liveRegionOf(element);
      if (region) changed.set(region.node, region.politeness);
    };
    for (const record of records) {
      note(record.target);
      for (const added of record.addedNodes) note(added);
    }
    for (const [node, politeness] of changed) {
      const text = (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || lastText.get(node) === text) continue;
      lastText.set(node, text);
      announcements.push({
        time: Math.round(performance.now() - start),
        politeness,
        text,
        role: node.getAttribute("role"),
        // Screen readers do not announce regions that are not rendered (display: none) or
        // that sit inside aria-hidden.
        hidden: node.getClientRects().length === 0 || !!node.closest('[aria-hidden="true"]'),
      });
    }
  });

  const observe = () =>
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });

  const ids = new WeakMap();
  let nextId = 1;
  window.__srj = {
    /** Announcements since the last call. */
    take: () => announcements.splice(0),
    /** A stable number per element, to tell whether focus moved. */
    idOf: (element) => {
      if (!ids.has(element)) ids.set(element, nextId++);
      return ids.get(element);
    },
  };
}
