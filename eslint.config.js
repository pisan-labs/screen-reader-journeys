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
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  { ignores: ["node_modules/**", "web/**", "reports/**", "coverage/**"] },
];
