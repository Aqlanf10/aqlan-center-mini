# Patient plan response and action boundaries

This local contract covers `/api/patients/[id]/plans`, doctor reads through
`/api/plans?patientId=…`, the item-add response, `PatientPlans`, `OrthoPackageLink`,
and the ledger's action controls. It does not alter pricing, calculations,
ownership writers, database types/schema, or ledger read policy.

## Distinct grants

- `canViewPlans` permits the clinical plan read. The patient endpoint uses the
  canonical patient guard. The legacy doctor endpoint retains own-patient-only
  scope even with `canViewAllPatients`.
- Saved plan item prices are agreement snapshots, including negotiated discounts
  or explicit foreign-currency prices (pricing history `db17923ff`). They are not
  current catalogue prices. There is no separate agreement-price read grant:
  interpreting saved agreement amounts as patient-payment financial data is an
  explicit policy inference, using `canViewPatientPayments`.
- Doctor plan-financial read requires BOTH `workflow.doctor_financial_view=true`
  and canonical `canViewPatientPayments` access. The ledger's existing direct
  read guard does not use that global switch and is unchanged.
- `canViewServicePrices` grants current official catalogue prices only. It does
  not disclose saved agreements, receipts, balances, installment schedules,
  payment counts, overdue amounts, or due dates.
- `canEditPlans` with existing own-patient scope enables clinical plan creation,
  add/remove, procedures and sessions. Broader read scope never broadens writes.
- Collection, consent, completion and contract printing independently mirror
  their existing `canHandleMoney` guards. A finance-reading doctor gains none.

## Wire projection

Authorized plans preserve every original numeric value, with added
`financialVisible:true` and `hasInstallments` metadata. Hidden plans use an
explicit allowlist, with `financialVisible:false`, nullable monetary values,
`progress:null` and `installments:null`. Item financial values and item-progress
financial values are null; clinical item identity, tooth/site, service, state,
session counts, grouping, and completion counts remain. Reminder/consent note
metadata is redacted. No denied branch spreads a raw plan or item.

`hasInstallments` reveals only structural agreement eligibility. It distinguishes
a hidden schedule from an absent agreement and preserves the existing ortho
funding/link decision. Amounts, installment identities, counts, due dates and
payment progress remain hidden. Unknown/failed link reads are not described as
an agreement without installments. Existing clinical free-text notes remain
clinical fields; this is structured-field projection, not text classification.

Hidden values must never be coerced to zero. A true authorized zero remains zero.
Clinical grouping operates on nullable projections without financial arithmetic
on hidden items. Domain plan numeric types and pricing engines stay unchanged.

## Planned-visit calendar reads

Clinical plan admission never grants calendar visibility. The patient plans GET
resolves the same appointment-read scope as `/api/appointments` after the existing
`canViewPlans` patient guard, then uses `listPatientPlannedVisitReads`. The reader
shares one patient-local SQL row selector with the raw internal/mutation reader
and workflow, but returns only projected rows. The workflow's private raw source
remains available to its existing clinical alerts; it is not serialized by the
plans wrapper. An omitted scope defaults to no calendar access.

The response exposes `appointmentVisibility: all | scoped | hidden` independently
of row count. Each planned row also carries visibility, with `unknown` for an
inconsistent joined calendar reference. Appointment ID/date/time are projected
using the actual appointment's patient and provider, never the planned clinical
assignment. Clinical plan/visit identity, title, note, assignment, duration and
status remain unchanged. Ownership and `canViewAllAppointments` keep their
existing semantics; `canViewAllPatients` does not imply all-calendar reading.

`PatientPlans` requires both parent and row visibility, treats absent/legacy or
malformed metadata as unknown, and hides stale calendar fields during a pending
or failed refresh. It distinguishes an all-visible, planned row with an explicitly
absent appointment from a scoped/hidden/unknown row. Missing dates never become
scheduling guidance or write authority. Existing create, consent, item, financial,
owner-retirement and uncertain-write fences are unchanged.

## Creation compatibility and actions

All creation entry points require the server-derived `canEditPlans` capability.
Template creation and direct agreement creation remain available without a
catalogue or patient-financial read grant. Quick/manual catalogue-based creation
additionally requires the existing catalogue read grant. Creation form internals
and POST pricing/foreign-currency/discount authority are unchanged. Clinical
item selection uses the existing template catalogue's names-only response when
catalogue prices are denied; it does not invent a zero price.

Capabilities start false in `PatientPlans`; failed/revoked reads remove stale
plans and controls. Failed completion requests show the returned failure and do
not reload as though completion succeeded. Item-add success projects its aggregate
using the read grants; read projection is resolved before the writer runs.

Ledger invoice controls mirror `POST /api/invoices` (`canHandleMoney`);
collection mirrors `POST /api/payments` plus cashier `financeAccess.collectPayments`.
Optional `capabilities` and `readOnly` props can narrow these existing rules but
cannot elevate a role. Admin/reception writes remain available; doctor/accountant
read access never mounts a collection modal. Opening/legacy-arrangement and
admin correction controls also respect explicit read-only composition.

## Verification limits

Synthetic tests cover route matrices, revocation, ownership, foreign agreements,
recursive projection, unknown financial fields, true zero, item totals, clinical
creation compatibility, funding eligibility, denied doctor money actions,
authorized staff actions and failed completion. These are local mocked route/UI
checks, not PostgreSQL, live browser, CI or Production evidence. Other current
patient-module gaps remain tracked separately; this contract does not claim an
end-to-end patient-module completion.
