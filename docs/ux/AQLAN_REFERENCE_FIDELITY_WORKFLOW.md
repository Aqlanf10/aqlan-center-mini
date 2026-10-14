# Repeatable AQLAN reference-fidelity workflow

## Available tooling (verified 2026-10-14)

Next.js 16.3.8, React 19.2.8, Tailwind 3.4.19, Playwright 1.63.0, system Chromium, Vitest 4.1.11 and Playwright’s bundled pixelmatch comparator (not a separately installed package). Cloud and executor skill catalogs both returned empty. Neither Intelligent UI nor skill-creator is callable; no claim of using them is made, and no untrusted plugin is installed. This file is a repository workflow, not a generated/installed skill.

1. Verify branch/HEAD and preserve local changes. Inspect AGENTS.md and installed Next guides. Identify financial ownership before editing shared components.
2. Extract the 15 embedded reference PNGs and record their hashes/dimensions; inspect each full image. Measure frame/grid/type/spacing, not the HTML gallery wrapper.
3. Map reference regions to existing components and data. Keep canonical money writers, role checks, clinical contexts, form ownership and navigation guards. Unknown is not zero; currencies and plans stay independent.
4. Capture the approved baseline using the real built application on the isolated PostgreSQL harness. No production credentials, real records or permanent accounts.
5. Implement CSS modules/component markup in small reviewable changes. Keep logo and original clinical components. Use native buttons, disclosures and modal focus handling; preserve alert visibility and drafts.
6. Run typecheck/lint and focused behavior tests, then build. Do not run next dev against a simultaneous build of the same .next directory.
7. Run `npm run test:security-http -- __tests__/security-http/patient-premium-visual-ui.test.ts`. Optional `PATIENT_VISUAL_OUTPUT` chooses a local evidence directory. Capture viewport and full-page images at 1448/1280/390; keep comparable synthetic fixture content.
8. Compare actual screenshots side by side with the relevant PNG and inspect each at full size. Pixel differences are diagnostic only: extra currencies/warnings or responsive stacking need a written explanation, not suppression. Test keyboard focus/Escape/outside dismissal, denied roles, loading/error/empty states, retries and draft guards.
9. Update the matrix with actual evidence, failures and remaining gaps. Commit/push only the authorized branch; run full CI on its exact head. Share review images before any staging change. Do not merge main or deploy production.

Generate the portable comparison gallery without installing a dependency:

```sh
node scripts/visual/patient-reference-report.mjs /path/to/extracted-references /path/to/captures /path/to/report
```

The script uses the installed Playwright 1.63 comparator. Its internal export is version-specific; review this script when upgrading Playwright. Pixel differences are reported, never converted into a passing visual test by increasing a tolerance. Only the supplied 1448px PNGs are reference baselines.
