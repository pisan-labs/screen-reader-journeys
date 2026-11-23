import { mockSharedImage, SHARED_IMAGE_PATH } from "../mock.js";

export default {
  name: "Shared STEM image: download the tactile graphic's braille key",
  description:
    "A keyboard and screen reader user opens a shared STEM image, chooses the Tactile view, " +
    "downloads the key to the tactile graphic as a braille file (.brf) and hears that it " +
    "downloaded. In the virtual mode it then reads on, through the key shown on the page. Needs " +
    "the braille pull request (stem-accessibility/frontend#9).",
  start: SHARED_IMAGE_PATH,
  ready: "h1",
  setup: (page) => mockSharedImage(page),
  async run(sr) {
    await sr.tabTo({ role: "combobox", name: /choose a representation/i });
    await sr.selectOption("Tactile");
    await sr.tabTo({ role: "button", name: /download braille key/i });
    // The fixture's title is "Lab 2: Loops".
    await sr.activate({ expectDownload: /^lab-2-loops-tactile-key\.brf$/ });
    await sr.expectAnnouncement(/downloaded lab-2-loops-tactile-key\.brf/i);
    await sr.readPage({ max: 40 });
  },
};
