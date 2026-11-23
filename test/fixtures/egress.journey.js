// Self-test journey for the hosted server's network guard: test/fixtures/egress.html tries to
// reach addresses it must not, and test/server-worker.test.js checks that nothing got through.
export default {
  name: "Egress test page",
  start: "/egress.html",
  async run(sr) {
    await sr.tabTo({ role: "button", name: "Fetch internal addresses" });
    await sr.activate();
    await sr.expectAnnouncement("Done.");
  },
};
