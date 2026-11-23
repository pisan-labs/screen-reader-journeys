import { mockSharedImage, SHARED_IMAGE_PATH } from "../mock.js";

export default {
  name: "Shared STEM image: download the braille file",
  description:
    "A keyboard and screen reader user opens a shared STEM image, chooses the Braille (.brf) " +
    "representation, downloads the file and hears that it downloaded. Needs the braille pull " +
    "request (stem-accessibility/frontend#9).",
  start: SHARED_IMAGE_PATH,
  ready: "h1",
  setup: (page) => mockSharedImage(page),
  async run(sr) {
    await sr.tabTo({ role: "combobox", name: /choose a representation/i });
    await sr.selectOption("Braille (.brf)");
    await sr.tabTo({ role: "button", name: /download braille file/i });
    await sr.activate({ expectDownload: /\.brf$/ });
    await sr.expectAnnouncement(/downloaded .*\.brf/i);
  },
};
