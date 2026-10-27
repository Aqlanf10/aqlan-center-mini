# Multi-tooth filling invoice entry

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`, verified against fetched `origin/main` on 2026-10-26. Branch: `codex/multi-tooth-fillings`.

## Cause and repair

`multiSelect` excluded `tooth_surfaces`; the invoice row transformer also took only the first tooth and the dialog owned one shared surface array. Enabling the picker alone would therefore lose selected teeth or copy surfaces onto the wrong work.

The dialog now retains a surface map by tooth and presents a labelled selector for each selected tooth. Removing and reselecting a tooth starts with empty surfaces. Cancel/Escape leaves invoice rows unchanged. Historical filling entry keeps its existing single-tooth behavior.

Prospective filling/sealant selection generates one canonical row per tooth, each with quantity one, its own surfaces, and no clinical `groupId` or `episodeTeeth`. The existing editor-only `displayGroupId` permits one visible batch and one physician/price control while preserving independent children. Different filling surfaces do not split this visual batch; the tooth summary and details show them. The existing split action permits a separate physician or price. New teeth do not inherit existing case/plan-item choices; a changed surface clears that child's linkage. Existing form ownership continues to invalidate stale plan-selection evidence.

The server already preserves individual filling plan items; fillings do not require specialist cases. The validation change rejects multi-tooth or mismatched `episodeTeeth` on a filling instead of silently discarding them. Printed rows show the existing saved tooth/surface fields, without grouping saved lines or adding persistence metadata.

Service changes reset the selected batch. Currency changes re-quote each child's price and reset monetary decisions and plan-selection evidence while retaining the current clinical tooth/surface choices. Existing discount, catalog, recovery, and clinical-refusal contracts remain authoritative.

## Scope

Changes are limited to invoice tooth selection, its display projection, a small isolated InvoiceForm integration, one clinical site guard, the invoice print description, and regression tests. No migrations, patient numbering, collections, laboratory, cephalometric, owner-permission, or deployment changes.

## Verification record

- Locked dependencies installed with `npm ci`; Node 22.23.4, Next.js 16.4.2, Vitest 4.1.12.
- Environment contract and money aggregation guard passed.
- PostgreSQL 18.6 filling suite: 10/10 passed on a new local synthetic instance. Verified independent plan items, surfaces/prices/providers, 80,000 gross / 5,000 discount / 75,000 due, planned/billed status, no collection or fabricated specialist cases, idempotent replay, duplicate rejection, invalid clinical combinations, and exact existing-plan surface matching.
- Dialog interaction suite: 8/8 passed on the locked dependencies.
- Targeted tooth/group/editor/clinical suites: 97/97 passed. After the final stale-notice cleanup, the editor suite passed 21/21 again.
- Full ESLint: zero errors, 209 warnings; scoped ESLint: zero errors and one existing InvoiceForm hook warning. Explicit TypeScript check passed. The final production build, including the notice cleanup, passed.
- Built HTTP/Chromium/PostgreSQL journeys: 8/8 passed at 1280×1040 and 390×1040. Verified keyboard entry/selection, Tab containment, Escape and returned focus, cancellation/reselection, service/currency changes, distinct providers/prices, POST/GET, saved plan items, ledger values, print HTML and PDF. Saved surfaces were 16/MDO, 26/DB and 36/L. No horizontal document overflow was observed.
- The full unit run was stopped at the owner's usage-budget instruction before completion. Two existing tests had exceeded the default 5-second timeout: the live database-env alias import in `environment-parity.test.ts` and the runtime import scan in `development-runtime-tracing.test.ts`. A separate environment-parity attempt also timed out while other checks were running. These failures are not resolved; no test timeout/configuration was changed.

## Remaining verification

The latest browser fixture changes the phone viewport to 390×844 and adds explicit dialog-footer/vertical-scroll evidence; that version has not run. The last notice cleanup was covered by editor callbacks but has not been exercised in the built browser. Full unit completion, a quiet rerun of the two timed-out tests, and remote CI remain outstanding. A stale dialog callback after changing service can still display an obsolete informational notice even though the row mutation is refused; review that presentation edge on resumption.

Public branch/PR publication is on hold under the owner's latest instruction. This is a local checkpoint, not release readiness.

All database, HTTP and browser fixtures are synthetic. No production database or real patient was accessed. No merge or Railway deployment was performed.

## Local sequential resumption — 2026-10-26

Restored checkpoint `81d41207e01814b3adcfe5d7438a682335502fd3` and independently verified exact tree `8bd9eb515a23ba7f2f3fb486003cfb51b2e33984` before edits. No public upload, deployment, install, or build was performed.

The stale informational notice described above was reproduced by strengthening the service-change callback regression. InvoiceForm now checks the latest committed dialog snapshot identity before either canonical row mutation or notice mutation. Cancel/reopen of the same row creates a different identity, so a dismissed callback cannot close or change the replacement dialog. Regression coverage checks canceled and reopened dialogs, unchanged tooth payloads/notices, and service replacement.

An additional form-level regression distinguishes canonical row linkage from explicit plan-selection evidence: a display-only split retains explicit child selections and ready preview evidence; a surface edit invalidates the form owner and clears all explicit plan/item choices, including the unchanged tooth, before fresh preview. No promise is made that untouched explicit choices survive a clinical edit.

Fresh local evidence: five focused unit/editor/dialog suites passed 98/98; isolated synthetic PostgreSQL filling suite passed 10/10 using the established owner runner, which stopped its loopback cluster afterward. Scoped lint has zero errors and one pre-existing hook warning. Default-heap TypeScript attempts exhausted the 2GB heap; the serialized 4GB retry passed (`tsc --noEmit --incremental false`).

The latest browser fixture was inspected: it uses 390×844 and checks footer bounds, an unobscured confirm-button hit target, no horizontal overflow, and actual vertical scrolling. It has NOT been executed on this resumed source. There is no matching built app in this worktree; with roughly 680MB disk headroom, no duplicate build was attempted. Full build, full suite, and actual mobile/browser acceptance remain outstanding. Earlier browser passes above are historical checkpoint evidence only, not acceptance of this resumed source.
