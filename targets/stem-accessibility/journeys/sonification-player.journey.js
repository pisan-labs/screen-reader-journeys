import { mockSharedChart, mockSpeechSynthesis, SHARED_CHART_PATH, siteSpeech } from "../mock.js";

const PLAY = { role: "button", name: "Play sonification" };

export default {
  name: "Shared chart: play and stop the sonification",
  description:
    "A keyboard and screen reader user opens a shared chart, finds the sonification described in " +
    "words, plays it with Enter, hears that it is playing, and stops it with X. The sound itself " +
    "cannot be heard here, so the journey checks the text alternatives, the announcements and the " +
    "button's state. The page gets a stand-in speech engine (headless browsers have none), and the " +
    "transcript notes what the player's own voice said. Needs the sonification pull request " +
    "(stem-accessibility/frontend#10).",
  start: SHARED_CHART_PATH,
  ready: "h1",
  setup: async (page) => {
    await mockSharedChart(page);
    await mockSpeechSynthesis(page);
  },
  async run(sr) {
    // The written equivalent of the sound, in the player's region. The fixture has five rows.
    const player = sr.page.getByRole("region", { name: "Sonification" });
    const tree = await player.ariaSnapshot({ timeout: 5000 }).catch(() => "");
    const description = tree.match(/heading "What you will hear".*\n\s*- paragraph: (.*)/)?.[1] ?? "";
    sr.expect(/5 short notes/.test(description), 'The sound is described in words, under "What you will hear"', description || "no description found");

    await sr.tabTo(PLAY);
    await sr.activate();
    await sr.expectAnnouncement(/playing/i);
    // aria-disabled while playing: focus stays on the button, which says it is unavailable.
    await sr.expectFocus(PLAY);
    sr.expect(/\bdisabled\b/.test(sr.last.focus?.spoken ?? ""), "While it plays, the button is marked unavailable", sr.last.focus?.spoken);
    sr.note(`The player's own voice said: ${(await siteSpeech(sr.page)).join(" ") || "(nothing yet)"}`);

    await sr.page.waitForTimeout(1000);
    await sr.press("x", "X");
    const ready = await sr.page
      .getByRole("button", { name: PLAY.name, disabled: false })
      .waitFor({ timeout: 5000 })
      .then(() => true, () => false);
    sr.expect(ready, "X stops it: the button is available again", ready ? "within 5 s" : "still unavailable after 5 s");
    sr.note(`The player's own voice said: ${(await siteSpeech(sr.page)).join(" ") || "(nothing)"}`);

    // Move away and back, as a user would to hear the button's state again.
    await sr.shiftTab();
    await sr.tab();
    await sr.expectFocus(PLAY);
    // What follows the button: the stop key is only in a hint after it (virtual mode).
    await sr.readPage({ max: 4 });
  },
};
