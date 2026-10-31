import { equal, invariant } from "../../lib/scoped-braces-exception.mjs";

// Dependency resolution only, never an advisory disposition. Exact development
// consumers use official parser/minimatch fixes; all audit checks remain active.
// No braces override, version range, additional consumer or arbitrary override
// is admitted. Changing this object requires independent security review.
export const REVIEWED_OVERRIDES = Object.freeze({
  "tailwindcss@3.4.19": Object.freeze({ "postcss-selector-parser": "7.1.6" }),
  "postcss-nested@6.2.0": Object.freeze({ "postcss-selector-parser": "7.1.6" }),
  "eslint@10.14.0": Object.freeze({ minimatch: "11.0.3" }),
  "@eslint/config-array@0.23.5": Object.freeze({ minimatch: "11.0.3" }),
  "@typescript-eslint/typescript-estree@8.70.0": Object.freeze({ minimatch: "11.0.3" }),
});

export function validateReviewedOverrides(manifest) {
  invariant(Object.hasOwn(manifest, "overrides") && equal(manifest.overrides, REVIEWED_OVERRIDES),
    "unreviewed dependency overrides");
}
