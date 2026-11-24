// What a screen reader would say about the focused element, and what we can check about it.

/** States worth reading out, in the order screen readers usually say them. */
const STATE_PROPERTIES = ["expanded", "checked", "pressed", "selected", "disabled", "required", "invalid", "readonly"];

/**
 * Describe the focused element using Chromium's accessibility tree (the same data screen readers
 * get from the browser), plus page facts the tree does not hold: aria-hidden ancestors, a visible
 * focus indicator, and a short selector for reports.
 */
export async function describeFocusChromium(page, cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: DEEP_ACTIVE_ELEMENT, objectGroup: "srj" });
  let ax = null;
  if (result?.objectId) {
    try {
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
        objectId: result.objectId,
        fetchRelatives: false,
      });
      ax = nodes[0] ?? null;
    } catch {
      ax = null;
    }
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "srj" }).catch(() => {});
  }
  const dom = await page.evaluate(domFacts);
  const states = {};
  for (const property of ax?.properties ?? []) {
    if (STATE_PROPERTIES.includes(property.name)) states[property.name] = property.value?.value;
    if (property.name === "level") states.level = property.value?.value;
  }
  return {
    role: ax?.ignored ? "(hidden from screen readers)" : (ax?.role?.value ?? dom.tag),
    name: ax?.ignored ? "" : (ax?.name?.value ?? "").trim(),
    description: (ax?.description?.value ?? "").trim(),
    states,
    ...dom,
  };
}

/** The same description without Chromium-only APIs (WebKit, Firefox): role and name from Playwright's ARIA snapshot. */
export async function describeFocusPortable(page) {
  const dom = await page.evaluate(domFacts);
  let role = dom.tag;
  let name = "";
  try {
    const snapshot = await page.locator(":focus").first().ariaSnapshot({ timeout: 1000 });
    const match = snapshot.match(/^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/);
    if (match) {
      role = match[1];
      name = (match[2] ?? "").replace(/\\"/g, '"');
    }
  } catch {
    // Nothing focusable is focused (the body).
  }
  return { role, name, description: "", states: {}, ...dom };
}

/**
 * The element that really has focus. document.activeElement stops at a shadow host (a custom
 * element such as the HintWise footer), so follow open shadow roots down to the focused element.
 */
const DEEP_ACTIVE_ELEMENT = "(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; })()";

/** Runs in the page. */
function domFacts() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  /** Like el.closest(selector), but also through the shadow hosts above it. */
  const closestAcross = (node, selector) => {
    for (let at = node; at; at = at.parentElement ?? at.getRootNode().host ?? null) {
      if (at.matches?.(selector)) return at;
    }
    return null;
  };
  if (!el || el === document.body || el === document.documentElement) {
    return { tag: "body", selector: "body", domId: 0, isBody: true, insideAriaHidden: false, focusIndicator: null, visible: true };
  }
  const style = getComputedStyle(el);
  const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? `outline ${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}` : "";
  const shadow = style.boxShadow && style.boxShadow !== "none" ? `box-shadow ${style.boxShadow}` : "";
  const rect = el.getBoundingClientRect();
  const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  const selector = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + classes.map((c) => `.${c}`).join("");
  return {
    tag: el.tagName.toLowerCase(),
    selector,
    domId: window.__srj?.idOf?.(el) ?? null,
    isBody: false,
    insideAriaHidden: !!closestAcross(el, '[aria-hidden="true"]'),
    // A heuristic: an outline or box-shadow while focused. Other indicators (background, border,
    // underline) are not detected and show as missing.
    focusIndicator: outline || shadow || null,
    visible: rect.width > 0 && rect.height > 0,
  };
}

/** Roughly what a screen reader says on reaching the element, e.g. `Download braille file (.brf), button`. */
export function speakFocus(focus) {
  if (focus.isBody) return "(nothing focused)";
  const parts = [];
  if (focus.name) parts.push(focus.name);
  parts.push(focus.role);
  for (const [state, value] of Object.entries(focus.states ?? {})) {
    if (state === "level") parts.push(`level ${value}`);
    else if (value === true || value === "true") parts.push(state);
    else if (state === "expanded" && (value === false || value === "false")) parts.push("collapsed");
    else if ((state === "checked" || state === "pressed") && (value === false || value === "false")) parts.push(`not ${state}`);
    else if (value === "mixed") parts.push(`${state} mixed`);
  }
  if (focus.description) parts.push(focus.description);
  return parts.join(", ");
}

/** Problems a screen reader or keyboard user would meet at this stop. */
export function checkFocus(focus) {
  if (focus.isBody) return [];
  const findings = [];
  if (focus.insideAriaHidden) {
    findings.push({
      level: "error",
      rule: "focus-in-aria-hidden",
      message: "Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it.",
    });
  } else if (!focus.name) {
    findings.push({ level: "error", rule: "no-name", message: "Focus lands on an element with no accessible name." });
  }
  if (["generic", "none", "presentation", "div", "span"].includes(focus.role)) {
    findings.push({ level: "warning", rule: "no-role", message: "A focusable element has no role, so screen readers cannot say what it is." });
  }
  if (!focus.focusIndicator) {
    findings.push({
      level: "warning",
      rule: "focus-indicator",
      message: "No focus indicator found (no outline or box-shadow when focused). Check it by eye; other styles are not detected.",
    });
  }
  if (!focus.visible) {
    findings.push({ level: "warning", rule: "invisible-focus", message: "The focused element has no size on screen." });
  }
  return findings;
}

/** Does the focus match `{ role, name }`? `name` is a string (exact, ignoring case and spaces) or a RegExp. */
export function matchesFocus(focus, matcher) {
  if (!matcher) return true;
  if (matcher.role && focus.role !== matcher.role) return false;
  if (matcher.name instanceof RegExp) return matcher.name.test(focus.name);
  if (typeof matcher.name === "string") return normalize(focus.name) === normalize(matcher.name);
  return true;
}

const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function describeMatcher(matcher) {
  const name = matcher.name instanceof RegExp ? String(matcher.name) : matcher.name ? `"${matcher.name}"` : "";
  return [matcher.role, name].filter(Boolean).join(" ");
}
