// A page whose last links sit in an open shadow root, as the HintWise footer's do.
export default {
  name: "Shadow DOM test page",
  start: "/shadow.html",
  async run(sr) {
    await sr.walkTabOrder();
  },
};
