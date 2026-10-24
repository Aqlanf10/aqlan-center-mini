// Static checks for this harness only. The repository config ignores every *.mjs, so these files are
// linted with this config instead, using the repository's pinned ESLint and @eslint/js (package-lock.json).
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", performance: "readonly", URL: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
      "no-undef": "error",
      "no-constant-condition": "error",
      "no-unreachable": "error",
      "eqeqeq": "error",
      "prefer-const": "error",
    },
  },
];
