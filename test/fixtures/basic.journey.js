// Self-test journey for test/fixtures/basic.html.
export default {
  name: "Basic test page",
  description: "Save announces a status; the rest of the page has known problems the tool must report.",
  start: "/basic.html",
  async run(sr) {
    await sr.tabTo({ role: "button", name: "Save" });
    await sr.activate();
    await sr.expectAnnouncement("Saved.");
    await sr.walkTabOrder();
  },
};
