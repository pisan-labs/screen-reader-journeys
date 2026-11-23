import { mockSharedImage, SHARED_IMAGE_PATH } from "../mock.js";

export default {
  name: "Shared STEM image: Tab through the Summary view",
  description:
    "Every Tab stop on a shared image's Summary view, with what a screen reader says at each. " +
    "The visual flowchart is hidden from screen readers, so none of its parts should be a Tab " +
    "stop (fixed by stem-accessibility/frontend#16).",
  start: `${SHARED_IMAGE_PATH}?view=summary`,
  ready: "h1",
  setup: (page) => mockSharedImage(page),
  async run(sr) {
    await sr.walkTabOrder();
  },
};
