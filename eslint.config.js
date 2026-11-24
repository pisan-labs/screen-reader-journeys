// `npm run lint` for the hosted service (server/), the tool (src/), the journeys (targets/) and
// the tests. The dashboard (web/) has its own configuration.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      // Node's globals only: a browser global in server code would lint clean and then throw.
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // These hold functions that run in the tested page (page.evaluate, addInitScript), so they
    // also get the browser's globals. Nothing in server/ does.
    files: [
      "src/drivers.js",
      "src/focus.js",
      "src/recorder.js",
      "src/voiceover-web-content.js",
      "targets/stem-accessibility/mock.js",
      "test/dashboard.test.js",
      "test/focus.test.js",
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  { ignores: ["node_modules/**", "web/**", "reports/**", "coverage/**"] },
];
