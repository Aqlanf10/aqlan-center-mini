# M2 slice 76 — the dental chart on the canonical runtime (group 3, 2026-11-04)

Fifth contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (2 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/chart` | `read:patients.clinical` (one of `clinical.plans.view`, `clinical.visits.document`, `clinical.xrays.view`) inside the patient scope; `patientChartWith` on the owning snapshot | `canAccessPatient` (doctor/reception/admin labels) |
| `POST /api/patients/[id]/chart` | `clinical.visits.document` inside the patient scope **and** the validated clinician link or the protected owner | doctor/admin labels with patient access |

## Behaviour

- **Never wider than legacy.** The legacy write was for the doctor and admin labels only. The canonical write needs the documenting grant *and* the actor's clinician link (or the protected owner). A documenting account without the link (for example an assistant) is refused with 403 and an Arabic message, before the patient scope is consulted.
- **Same body, same lock order.** `recordToothConditionOn` is the legacy body unchanged, on the caller's transaction:
  - the patient row `FOR KEY SHARE`, then the visit `FOR SHARE`;
  - another patient's visit is refused (409) without saying whether it exists;
  - events are append-only — no update or delete exists.
- **Audit with the event.** The `chart.record` audit row commits in the same transaction. On the legacy path it was written after the commit. It carries the event id (`السجل`) as the receipt.
- **Scope.** A patient outside the scope reads and writes as missing (404). The scope check takes no row lock, so the writer's own lock order stays intact.
- **Duplicate prevention.** `requestKey` is optional, as for the diagnosis in slice 74:
  - the reviewed chart editor (whose body is pinned by its tests) already blocks a repeated press with a synchronous guard, and never offers a blind retry after an uncertain save;
  - when a key is sent, the receipt applies — the same request returns the first event (`replayed`), and a different request with the same key is refused (409).
- **Screen.** The canonical patient file shows the chart to any account holding a clinical grant inside the scope. The editor is offered by the capability projection (`clinical.visits.document` or the owner) through a new optional `canEdit` prop. Without the prop, the legacy role labels decide as before. The server decides every write.
- **No money.** The chart has no price or amount; the GET response is only tooth events, the chart built from them, and its summary.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `chart-canonical` (new) | 4/4 — keyed double press keeps one event, audit with the event, reused key 409; refusals without the link, without the grant, outside the scope, another patient's visit, invalid tooth or condition — none writes; the read by grant and scope; revocation refuses an earlier session |
| Legacy chart PG suites (`tooth-chart-visit-integrity`, `charted-visit-relink`, `clinical-doctor-identity`, inventory writer guards, slice-74 records) | 80/80 |
| Chart and perio unit tests (ownership, layout, perio containment, invoice tooth selection, session pages) | 130/130 |
| Journey `canonical-chart-journey` (portOffset 128) | with the batch gates |

## Limits

- `GET /api/patients/[id]/clinical-context` (the navigation graph of a plan, item or visit) is a plan-authority read. It moves with the plans and visits contracts, not with the chart.
- Periodontal recording stays unavailable on both paths, as before (`recordingAvailable={false}`).
