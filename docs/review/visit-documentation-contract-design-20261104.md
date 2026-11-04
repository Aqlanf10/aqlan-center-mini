# Visit documentation contract — design before code (M2 group 3, last contract, 2026-11-04)

The last group-3 contract is the visit cockpit:

- `GET /api/visits/[id]/clinical` — the visit as the doctor works it;
- `POST /api/visits/[id]/clinical` — save the notes and procedures, sign, add an addendum;
- `GET /api/visits/[id]/lab-work-command` — reconcile a lab draft.

Unlike the earlier clinical contracts, this one is **clinical and financial at once**:
- the view carries prices, totals, currencies and invoice references;
- signing generates the invoice, moves inventory and records the orthodontic adjustment in one transaction.

This note classifies every field and every action. It separates what follows from rules already in force from what needs the owner's decision. Nothing here changes behaviour until the slices land.

## 1. Rules already in force that decide most of it

- **Money rule (owner, 6615124926).** Prices and financial information only for actors explicitly granted the matching type — in the server, the API, direct access and print. View and edit are separate, and there are no automatic grants.
- **Never wider than legacy.** The canonical path may narrow a role label's reach to an explicit grant, but never widen it.
- **The map** (names approved by the owner, Dot 6484846432) gives `POST /visits/[id]/clinical` the capability `clinical.visits.document`, and signing additionally `clinical.visits.sign`. `GET /visits/[id]/billing-preview` and `financial-context` are `finance.invoices.view`.
- **The same map already rules the price-override fields** (correction, 2026-11-04 — the first version of this note missed it and asked the owner):
  - `priceOverrides[].kind=discount` needs `finance.discounts.apply`, within `billing.max_discount_percent`; beyond the ceiling, `finance.discounts.override`;
  - `priceOverrides[].kind=increase` needs `finance.price-increases.apply`;
  - `orthoSession` needs `clinical.ortho.edit`.

## 2. The read: field-by-field projection (`GET /api/visits/[id]/clinical`)

Admission: `read:patients.clinical`, with the visit inside the scope by the queue read's condition.

| Group | Fields | Shown with |
|---|---|---|
| Clinical record | `id`, `patientId`, `patientName`, `chiefComplaint`, `examination`, `diagnosis`, `treatmentDone`, `nextPlan`, `addendum`, `doctorId`, `status`, `signedAt`, `signedBy`, `arrivedAt`, `suggestions`, `referral`, `previousVisit`, `latestDiagnosis`, `activeCases`, `plannedVisit`, `labOrders`, lab-work flags | a clinical grant |
| Procedures (clinical part) | per line: `id`, `serviceId`, `serviceName`, `category`, `toothCode`, `surfaces`, `quantity`, `doctorId`, `planItemId`, `note`, lab-work fields | a clinical grant |
| Outstanding work (clinical part) | `planItemId`, `serviceId`, `planTitle`, `serviceName`, `toothCode`, `sessionCount`, `doneSessions`, `quantity`, `status`, `surfaces`, `caseId`, `caseSite`, `unmetRequirements`, `clinicalConsentRecorded`, lab-work fields | a clinical grant |
| Orthodontic chairside | `ortho` without `adjustmentBillingClass` | `clinical.ortho.view` (independent ortho projection) |
| Signing gates | `amendedServiceConflict`, `planItemsMatched`, `planTitle` | a clinical grant (booleans and titles, no amounts) |
| **Money** | per line `unitPriceMinor`, `totalMinor`, `planCurrency`; visit `totalMinor`, `billingCurrency`, `planCurrency`, `invoiceId`, `invoiceReferenceState`, `planWarning`; `sessionPricing`; outstanding `unitPriceMinor`, `billingRule`, `billingStatus`, `planCurrency`, `includedByAgreement`, `prebilled`, `origin`, `originInvoiceId`, `billedInvoiceId`, `financialReviewRequired`; `ortho.adjustmentBillingClass` | `finance.invoices.view` (as the visit billing preview), or the protected owner |

Hidden groups are omitted, never zeroed. A doctor without the invoice view still sees what was done and what remains, but not what it costs.

## 3. The writes (`POST /api/visits/[id]/clinical`)

| Action | Canonical rule | Basis |
|---|---|---|
| Save notes (chief complaint … next plan) | `clinical.visits.document` inside the scope; the clinician link or the owner, or a documenting account for **today's visits only** | legacy: doctor/admin any day, assistant today only |
| Addendum on a signed visit | `clinical.visits.document` + `clinical.visits.sign`; the clinician link or the owner | the map's sign rule; legacy doctor/admin |
| Procedures without a price | `clinical.visits.document`; the price comes from the plan item or the service catalogue on the server | legacy |
| Procedure price below the catalogue (discount) | + `finance.discounts.apply` with a written reason, within `billing.max_discount_percent`; beyond it `finance.discounts.override` | the approved map (legacy: role labels and the same ceiling) |
| Procedure price above the catalogue (increase) | + `finance.price-increases.apply` with a written reason | the approved map (legacy: admin only) |
| Orthodontic session data at signing | + `clinical.ortho.edit` | the approved map |
| Sign | `clinical.visits.sign` + the clinician link or the owner. Invoice, inventory and ortho adjustment in the same transaction, as legacy. The signer needs no money view: amounts are computed on the server and never returned without `finance.invoices.view` | legacy doctor/admin; map |
| Lab draft inside the save (`labRequestKey`) | `clinical.lab.order` (lab create since slice 68) inside the scope | legacy doctor/admin |

## 4. Owner decisions needed (isolated; nothing is assumed)

1. ~~Price overrides while documenting.~~ **Already decided by the approved map** (§1): discount `finance.discounts.apply` (beyond the ceiling `finance.discounts.override`), increase `finance.price-increases.apply`. Nothing to ask.
2. **"No charge" for an orthodontic adjustment outside the contract (`outsideContractDecision`).** This is a clinical-financial decision that legacy reserved to doctor and admin.
   - Proposal: `finance.invoices.create` or `finance.agreements.manage`.
   - Alternative: the clinician link, as legacy.
3. **The money view in the cockpit.** The proposal is `finance.invoices.view`, the grant of the visit billing preview. The owner may prefer `finance.patient-ledger.view`.

Until these are decided, the canonical path will:
- serve the read with the money group by `finance.invoices.view` (proposal 3);
- save notes, add addenda and save procedures, with price overrides by the map's grants (§3);
- refuse a no-charge decision on the canonical path (409), rather than guessing.

Signing lands in its own slice once decision 2 is answered: a signature with an unresolved billing decision must not be half-supported.

## 5. Slices

| Slice | Content | Waits on |
|---|---|---|
| 84 | `GET /visits/[id]/clinical` with the projection above; `GET lab-work-command` | — (proposal 3 applies the money rule; reversible) |
| 85 | `POST` save notes, addendum, procedures; price overrides by the map's grants | — |
| 86 | `POST` sign (invoice, inventory, ortho adjustment, lab command); no-charge refuses (409) until decision 2 | decision 2 |
