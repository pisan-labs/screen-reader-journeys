// Works on any site: Tab through the home page once and report every stop.
export default {
  name: "Home page: Tab order",
  description: "Every Tab stop on the site's home page, with what a screen reader says at each.",
  start: "/",
  async run(sr) {
    await sr.walkTabOrder();
  },
};
