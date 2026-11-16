# Cephalometry development — report integrity slice

Base: PR #541, `4e88b6a791d859cc9a066888f54c0eddff91dde7`.
Status: review-only candidate. Do not merge or deploy automatically.

## Scope

This changes the actual `app/print/ceph/[id]/page.tsx`, not a separate clinical
engine prototype. No database/schema/landmark writes, new DB, Railway access,
clinical calculation change or historical remeasurement is included.

- Missing/invalid acquisition dates no longer borrow the print year. Birth year
  alone yields an explicitly approximate age range, never a fabricated birthday.
- Image calibration is labelled in mm/px. No paper scale is inferred from it,
  and no uncalibrated 1:100 label is printed.
- A versioned completed study's diagram uses only its verified saved landmarks.
  Empty/invalid/unversioned saved geometry never falls back to the current draft.
- Additional source identity checks bind the witness to study/patient/document.
- Approval actor/time use the saved witness when available.
- Discarded studies cannot be presented as draft clinical reports.
- Clinical measurements/diagnosis remain sealed; the drawing is only labelled
  point connections, not inferred/template anatomy or a reconstructed radiograph.
- Current demographic metadata are explicitly distinguished from sealed evidence.
- Table markup is deduplicated while retaining grouping, reference disclosure,
  quarantine rules, patient authorization and clinic header/footer integration.

## Verification actually performed

84 tests were executed offline against these candidate TypeScript/TSX files:
67 helper cases and 17 actual-page/actual-component route-logic cases. The local
runner uses TypeScript transpilation, a Vitest registration adapter, and a JSX
node collector with explicit mocked read dependencies. This is NOT an execution
of the installed repository Vitest/esbuild/React/Next stack, full typecheck, lint,
PostgreSQL, HTTP, or clinical validation. Both test files use Vitest and esbuild
for the repository runner; those original-stack gates remain required.

The dependency-free production helper passed strict TypeScript compilation.
Four focused expressions from the pinned original print page reproduce the age,
scale and tracing issues before this patch; this is not a full baseline run.
A local Chromium rendering of the isolated synthetic JSX output was inspected;
it is not a live application or patient session.

Run in a complete checkout with the locked dependencies:

```
npx vitest run __tests__/ceph-report-view.test.ts __tests__/ceph-report-route-provenance.test.ts __tests__/ceph-presentation.test.tsx
npm run typecheck
npm run lint
npm test
npm run build
```

Then perform authorized synthetic HTTP/browser acceptance before staging release.
No tests use patient photographs, patient coordinates, names, identifiers,
commercial executable resources, license keys or book scans.

## Deliberately not resolved by this slice

IMPA/U1SN/APDI angle conventions, new landmark semantics, distinct occlusal
planes, ratio calibration independence, reference validation, comparative
exclusion reasons, AI landmark detection and clinical acceptance remain separate
work. Do not mark the entire cephalometric unit complete or clinically validated.
Engine identity/checksum are unchanged because `lib/ceph.ts` is unchanged.

Historical saved coordinates are drawn as labelled point connections using this
report renderer, not claimed to be an archived pixel-exact drawing. Presentation
source checks complement, but never replace, upstream provenance verification.
