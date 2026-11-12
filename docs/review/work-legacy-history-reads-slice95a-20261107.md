# M2 slice 95a — the historical onboarding reads on the canonical runtime (2026-11-07)

Owner decision G4-2 (6648682456). The contract is section 15 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. Section 15 also covers 95b–95d (the writers) and records four policy points the map leaves open.

## Routes

| Route (GET) | Canonical |
|---|---|
| `/api/patients/[id]/legacy` | The old system's archive is money throughout: `finance.patient-ledger.view` inside the patient scope; without it, the legacy 403 (no projection) |
| `/api/patients/[id]/legacy-treatments` | The clinical description with the record read; every amount, currency, opening and free text with the ledger view; action flags from canonical grants |
| `/api/patients/[id]/historical-documents` | The identity and the lines' clinical description with the record read; every amount, term, source hash and history reason with the ledger view; `correctionAvailable` needs `patients.history.correct` and `finance.opening-balances.manage` |
| `/api/patients/[id]/legacy-onboarding` | No amounts; the plan, item and document sources with `clinical.plans.view` |

- All four run in one read-only snapshot under the new record read `read:patients.history`. A patient outside the scope reads exactly like a missing one.
- The administrator label and the setting `finance.reception_adds_opening_balance` decide nothing on the canonical path (G4-6). The legacy paths are unchanged.
- No file is returned by these reads; the original mixed attachment keeps its own financial guard.

## Readers

Each reader is split into a `…With` form on the caller's snapshot, and the legacy functions keep their own transactions:
- `patientLegacyHistoryWith`;
- `listLegacyTreatmentsWith`;
- `listHistoricalDocumentsWith`;
- `patientLegacyOnboardingWith`.

In `patientLegacyHistory` the two queries now run one after the other on one reader instead of in parallel on the pool; the result is the same.

## Tests

| Gate | Result |
|---|---|
| PG `legacy-history-reads-canonical` | 4/4 |
| Failure-first | With the record projection removed (full rows for every reader), the two money tests failed. Restored, they pass. |
| Legacy PG (every suite touching the four readers or the record reads) | 34 files, 618/618 |
| Related unit tests | 23 files, 357/357 |
| Audits | 10/10, after declaring the four projections in the map |
| tsc | Pass |
| lint | Clean |

The 4 PG tests cover:
- **Agreements:** the record read shows the service, tooth and status, and no money key or amount at any depth; the ledger view equals the legacy list; the flags follow grants (record and opening management give `add` and `edit`); the label gives nothing.
- **Historical documents:** the identity and lines without money; the ledger view equals the legacy body (with `correctionAvailable` off); the correction grants turn it on.
- **Archive and onboarding:** the archive is refused without the ledger view and equals the legacy body with it; the onboarding equals legacy for a plan reader and is restricted without `clinical.plans.view`.
- **Scope and revocation:** the `own` doctor gets the same code and message for an outside patient as for a missing one, on all four reads; inside, the archive reads. Revoking the ledger view refuses the archive.

The historical document fixture is written by the real writer. The fixture database disables legacy staff authority, so the writer receives a branded actor whose re-check passes; this is used for seeding only.
