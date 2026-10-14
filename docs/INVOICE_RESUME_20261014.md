# Invoice completion — resumed, not release-ready

## Source truth

Resumed original saved worktree `/workspace/compat-invoice-03d325a8`, clean at `1a19d65f7621e7ebf30c30699d938cd4dbdc9e42` / tree `08e9b9091340865f8d0e59851cbfd62f78aa10cd`. New branch: `feat/invoice-resume-20261014`. No prior local work was discarded.

Read-only remote verification on 2026-10-14: main `148fcbeac229cb279848e6ea37049d1599a4fafe`; `feat/invoice-completion-local-20261012` and handoff both `1a19d65f`; reception PR327 `d9690edf747d34da2195badb9c7b7863e7270abd`; design staging PR329 `175957f4e074d28b819d00a51f3f1e6d53b3d78b` / tree `be6da19feeafa9f0e89b91cf7082154be5f6f64e`. These refs were fetched for inspection, not merged.

Coordinator-only continuation `5df523be39e6ef589b7f19d6e7d07636793df4f4` / reported tree `91d8eb4b6f38f6564fdbc79035b061e7037ff0aa` is **absent** from this Git object store and saved worktrees/review folders. No claim is made about its implementation or tests. Requested its correction/account-refresh/print delta rather than recreating known independent work blindly. Continue independent recovery work meanwhile.

## Identified approved invoice reference

Coordinator resolved the owner's 2026-10-12 21:09 “ممتاز التصميم” approval to the four local app previews shown at 21:05. Files remain at `/workspace/reviews/invoice-workspace/owner-preview-final/images/`; manifest created at 21:00:04 records preview build `5w_ynkOekx5xQ771hhwYH`. All four images were reopened on resumption. This is the invoice reference, distinct from the patient-file designer's gallery and current Staging appearance.

| File | SHA256 |
|---|---|
| new-treatment-1280.png | `33df4ec1c33713dab85facd4d36dc667482dfb31f29bdf8e88a4c5dd8d1872aa` |
| new-treatment-390.png | `f7dc46bde712454297c90b631840b7fd86ea29f4f3a263a05c823e9686f62c97` |
| historical-design-1280.png | `aa28b39ac4db9a0078cc341f0ef7af8bc16147d4022d928b7d3fddfb395dca8f` |
| historical-design-390.png | `6dc89aae30133ae31124671055ce68de709d97855800ca57a4473b97494d14cb` |

Images are evidence only, not included in Git. Historical save was intentionally disabled in that preview; current functionality needs new actual-app evidence. No general patient branding/sidebar changes are authorized in this slice.

## First bounded checkpoint

Added `lib/financial-command-journal.ts`: actual IndexedDB transactions persist immutable original intent before sending, isolate actor/patient namespaces, arbitrate simultaneous tabs, preserve uncertain commands, and leave a revision tombstone after validated completion to refuse stale drafts. No auth token, role authority or financial truth is stored. Browser data is recovery evidence only; server authority still controls every write. Payload is erased after acknowledged completion. Storage failures fail closed.

**At this checkpoint the journal is not yet wired into application writes.** Browser primitive checks are not end-to-end financial recovery acceptance. Next: wire create/historical/debt flows; add actual lost-reply → reload → exact replay and concurrent-tab journeys. Integrate coordinator correction changes when available; follow the full original handoff's unresolved items.

Observed on preserved application build `Vpjrxt770vqdC8eIXBAep`, disposable local PG18.6 only:

- Historical baseline: admin save/reload passed; reception save remained disabled. Cause confirmed by source and rerun: synthetic discount limit was 0% for its 6.25% positive-case discount. Fixture explicitly permits 10%; app/default authority unchanged.
- `resume-20261014-journal-browser`: historical app file **7/7 passed** after fixture correction. New journal test initially failed because the test bundle was not assigned to `window`; no product failure claimed from that harness error.
- `resume-20261014-journal-browser-fixed`: actual Chromium/IndexedDB **5/5 passed** (reload, actor/patient separation, two-tab race, exact acknowledgement/stale draft, original preservation, unavailable storage). Source snapshot `f5a340f2fa666ee2046814368a807561453886d9df38012c78dd003eb961a20c`; log SHA256 `f134d74d294f369581cac219a79ccd659873a0b14f7559b0078635498916e2ce`.
- Typecheck passed at source `1e256b681c08126af12d0993f464d8d7b16671fa93d39631c28a0022f9e8b347`, before the test-only bundle assignment fix. No final integration type/lint/full-suite pass claimed.

Raw logs/command records remain in `/workspace/reviews/invoice-workspace/`. No patient data, credentials, build outputs or bulky evidence are committed. No live database, deployment, merge or CI alteration.

Migration ownership remains 0059/0060 as documented in `INVOICE_INSTALLMENTS_COORDINATION.md`; no new number allocated or migration added. Shared integration review with reception must cover `lib/db.ts`, `lib/http-permissions.ts`, `lib/audit.ts`. Its checkout implementation was not copied.
