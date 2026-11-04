import { equal, invariant } from "../../lib/scoped-braces-exception.mjs";

// Dependency resolution only, never an advisory disposition. These exact
// development consumers use official parser/minimatch fixes without migrating
// Tailwind or ESLint. The legacy minimatch 3 consumers retain their compatible API.
// No braces override, version range, additional consumer or arbitrary override
// is admitted. Changing this object requires independent security review.
export const REVIEWED_OVERRIDES = Object.freeze({
  "tailwindcss@3.4.19": Object.freeze({ "postcss-selector-parser": "7.1.6" }),
  "postcss-nested@6.2.0": Object.freeze({ "postcss-selector-parser": "7.1.6" }),
  "@typescript-eslint/typescript-estree@8.70.0": Object.freeze({ minimatch: "11.0.3" }),
});

export function validateReviewedOverrides(manifest) {
  invariant(Object.hasOwn(manifest, "overrides") && equal(manifest.overrides, REVIEWED_OVERRIDES),
    "unreviewed dependency overrides");
}
