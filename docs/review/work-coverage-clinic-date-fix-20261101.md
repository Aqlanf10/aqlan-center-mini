# Coverage decision date — clinic midnight regression

Independent review found that slice 48 truncated a saved UTC instant to its UTC date. A decision saved at 2026-11-01 01:30 Asia/Aden (2026-10-31T22:30:00Z) therefore displayed 31 October. The exact component witness failed before the fix on published `1990b966`; the failed log is retained.

The canonical read now supplies the server-resolved clinic zone, and the existing `formatClinicDate` renders the saved instant. The client validates the zone and retains the original instant in the time element. No database storage, timestamp normalization, historical record, calendar business date or financial operation changed. No browser-local zone is used as clinic authority.

| Acceptance | Result |
|---|---|
| Component boundary / configured alternate clinic / calendar literal | Five positive tests; the exact midnight witness passes after the fix. |
| Projection and inventory/map guards | 40 tests pass in four files, including the five component tests and invalid/missing zone rejection. |
| PostgreSQL permissions and snapshot regressions | 25 tests pass; exact public field allowlist includes only the added clinic zone. |
| Built HTTP and Chromium | 11 tests pass, including a stored synthetic midnight decision, an American browser device, refresh, scope and revocation. |
| Typecheck, targeted lint, production build | Passed. Build `3O5pamdhHK7F_fGZsx2Da`; the synthetic 390px screenshot was inspected. |

Evidence and source hashes are in `evidence/work-coverage-clinic-date-20261101/manifest.json`. Inventory was regenerated and remains NOT_READY. No conversion count changes. Exact-head CI and independent acceptance of this correction remain pending publication; prior CI is not evidence for this new code. The original slice 48 UI acceptance remains open until this correction is reviewed. Slices 53–55 are separate work and are not included in this correction. No main merge, deployment or live change.
