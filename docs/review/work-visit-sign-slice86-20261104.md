# M2 slice 86 — visit signing, with the owner's decisions 6629149113 (2026-11-04)

Design: [visit documentation contract](visit-documentation-contract-design-20261104.md) §2–§4. The owner's decisions are recorded there before any code.

## The owner's decisions and where they live

### 1. "No charge" for an outside-contract orthodontic adjustment

Who may decide:
- **the protected owner** — always;
- **the adjustment case's responsible doctor** — only when all of these hold:
  - the validated clinician link equals `ortho_cases.responsible_doctor_id`;
  - the doctor holds `clinical.ortho.edit` (an existing grant that matches the meaning);
  - the owner-only setting `ortho.case_doctor_no_charge` is on.
- `finance.invoices.create` and `finance.agreements.manage` never substitute.

Enforcement:
- **At signing:** a coarse check runs before validation; the exact case check runs inside the locked body (`authorizeNoCharge`) against the adjustment's actual case.
- **After signing** (slice 52's decision route): the same setting now also gates the case doctor there, and the pending-decisions read offers `no_charge` by the same rule. Without this, the post-sign path would be a bypass.
- **Audit:** a 3–300 character reason is required. The reason, the decider and the basis (owner / case doctor with the owner's setting) are written to the `visit.sign` audit row in the same transaction.

### 2. The visit's amounts

- **Who sees them:** only holders of `finance.invoices.view` held explicitly, or the protected owner. This applies to the cockpit read (slice 84) and to the sign summary (invoice id, dues, currency, billing class).
- **Separate from the ledger:** `finance.patient-ledger.view` neither shows them nor is shown by them.
- **Tests:** the separation in both directions, and revocation (the next read hides the amounts).

### 3. Owner-controlled settings and explanations

| Where | What changes |
|---|---|
| Setting `ortho.case_doctor_no_charge` | BOOLEAN, default `"false"`, authority class (owner-only `settings.security.change`), reason required. It appears in the settings screen (staff section) from its definition. A delegate holding every delegable settings grant cannot write it (test) |
| Capability catalogue | `STAFF_CAPABILITY_NOTES` explain, under each capability in the staff editor, what `finance.invoices.view`, `finance.patient-ledger.view`, `clinical.ortho.edit`, `finance.invoices.create` and `finance.agreements.manage` do and do not reveal or decide |
| Route map | The `POST /api/visits/[id]/clinical` field rule `outsideContractDecision=no_charge`; the two slice 51–52 decision entries note the setting |
| Grants | None granted automatically; no real account touched |

## Signing (`POST /api/visits/[id]/clinical`, `action: "sign"`)

- **Transaction and writer:** the same admitted `clinical.visits.document` transaction as save and addendum.
  - The legacy body is extracted as `signClinicalVisitLockedOn`: patient-first locks, invoice, sessions, inventory, ortho adjustment, signed stamp.
  - The legacy `signClinicalVisit` wraps it with the same pre-check, commit/rollback order and post-commit read.
  - The query-protocol unit test runs the exact extracted body.
- **Who signs:**
  - `clinical.visits.sign` or the owner.
  - A signer without a clinician link finishes **today's** visits only, without orthodontic session data or a billing decision, and is never the default treating doctor (the legacy assistant finisher).
  - Orthodontic session data needs `clinical.ortho.edit` (the map).
- **Refused (409):**
  - an unlinked visit — link or open the file first, slice 81;
  - a visit carrying a durable lab identity, until the lab identity layer accepts a canonical actor.
- **Audit:** `visit.sign` is written in the same transaction (the legacy route wrote it after commit).
- **Messages:** refusal wording is shared with the legacy route (`lib/clinical-sign-messages.ts`).

## UI

- **Cockpit:**
  - a sign section for sign-grant holders or the owner;
  - the "no charge" option only for ortho editors or the owner, on a visit with an adjustment, with a reason field;
  - unmet requirements come back with a reason field;
  - signing is disabled while procedure edits are unsaved.
- **Staff editor:** shows the capability notes.

## Tests

| Gate | Result |
|---|---|
| PG `visit-sign-canonical` | 9/9:<ul><li>sign and audit; money only with the invoice view; the grant; unlinked; the finisher rule</li><li>no-charge: setting off and on; case doctor vs other ortho doctor vs finance grants; invalid reason and shape; revocation of the setting and of `clinical.ortho.edit`; the post-sign read's choices</li><li>amounts: ledger/invoice separation both ways and revocation</li><li>the setting is owner-only</li></ul> |
| PG slice 52 decision command | 24/24 (fixture runs with the owner's setting on, plus a new setting-off test) |
| Related PG | decision reads 40/40 |
| Legacy PG touching signing | 54 files, 604/604 |
| Related unit | 310/310 |
| Journey `canonical-visit-sign-journey` (offset 146) | in the batch gate |
| Journey `canonical-ortho-decision-write-journey` | seeded with the owner's setting; in the batch gate |
