import { MATH_IMAGE_PATH, mockSharedImage, sharedMathImage } from "../mock.js";

// The fixture's long description has 8 formulas: 7 inline ($…$) and one displayed ($$…$$).
const FORMULAS = 8;
const DISPLAYED = /the sum from i equals 1 to n of i equals n times open paren n plus 1 close paren over 2/i;

export default {
  name: "Shared STEM image: read the math in the Summary view",
  description:
    "A screen reader user opens a shared STEM image whose long description has math in it " +
    "(written as LaTeX between dollar signs). Each formula should be read as math, not as its " +
    "LaTeX source: the virtual mode reads the page line by line, and both modes Tab to the " +
    "displayed formula and check what it is called. Needs the math pull request " +
    "(stem-accessibility/frontend#11).",
  start: `${MATH_IMAGE_PATH}?view=summary`,
  ready: "h1",
  setup: (page) => mockSharedImage(page, sharedMathImage),
  async run(sr) {
    // MathJax loads on demand, after the page; wait for the displayed formula to be drawn.
    const drawn = await sr.page
      .getByRole("img", { name: DISPLAYED })
      .or(sr.page.getByRole("math", { name: DISPLAYED }))
      .waitFor({ timeout: 25000 })
      .then(() => true, () => false);
    sr.expect(drawn, "The displayed formula is drawn as math", drawn ? "" : "not drawn within 25 s");

    // Every formula should be readable as math: MathML (role "math"), or an image whose name is
    // its spoken form (MathJax's speech, which ends in "math"). No LaTeX source should be left
    // for a screen reader to spell out.
    const tree = await sr.page.getByRole("main").ariaSnapshot({ timeout: 5000 }).catch(() => "");
    const formulas = [...tree.matchAll(/^\s*- (img|math)(?: "((?:[^"\\]|\\.)*)")?/gm)]
      .filter(([, role, name = ""]) => role === "math" || /\bmath$/.test(name))
      .map(([, , name]) => name || "(MathML, no name)");
    sr.expect(formulas.length === FORMULAS, `All ${FORMULAS} formulas can be read as math`, formulas.join(" | ") || "none found");
    const source = tree.match(/\$|\\(?:sum|frac)/);
    sr.expect(!source, "No LaTeX source is left in the text", source ? `found "${source[0]}"` : "");

    // Virtual mode: what the emulated screen reader reads, line by line.
    await sr.readPage({ max: 200 });

    // Each formula is also a Tab stop, so it can be explored by keyboard.
    await sr.tabTo({ name: DISPLAYED });
    await sr.press("ArrowDown");
  },
};
