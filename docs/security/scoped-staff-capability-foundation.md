# Scoped staff capabilities: inert foundation, not a permissions rollout

## Scope and status

This slice adds pure, unconnected policy files and tests. No existing permission helper,
route, proxy, DB store, token claim, staff editor, account, clinical link or Production
configuration is changed. There are **no live grants and no owner assignment**. AI/Dot
features are outside this catalogue and work.

Source audited: local `de312aa7dfc8aff1f00fec3478db2de143697d17`, tree
`263367004572a251dcaef069eb61ff7a1e192ded`. The parent verified this tree matches remote
main `573ecf6222123c91b90dcf9c8135f486d8d4dd4b`. Paths/line references below refer to
that source snapshot, not a claim that all future commits preserve the same behavior.

Refreshed before publication onto local `1aaf15a` / released PR191 remote main
`8c1fe3659b94540c0cbdba41bf1fd9d1c54448d7`, independently verified to share tree
`ad418d06fd15dcfa814b33c772e3486c76d4a1b6`. The PR191 response-projection difference
is reconciled explicitly below; no released source file is modified by this slice.

## One future canonical permission document

`staff-capability-catalogue.ts` defines schema version 1, a separate policy version,
explicit operational capabilities, and two record scopes (`none`, `own`, `all`).
`staff-capabilities.ts` parses/resolves that document. A future migration should use
**one authoritative permission document**, replacing the legacy interpretation of
`users.permissions`, rather than adding another independently editable permissions
store or maintaining dual-write toggles. This slice creates no storage or migration.

The required fields are `schemaVersion`, positive safe-integer `revision`,
`patientScope`, `appointmentScope`, and `grants`. Each grant is a known capability
with a Boolean value. Absence and false both deny. Unknown fields/capabilities,
unsupported schemas, malformed JSON, invalid scopes, missing fields, inherited or
accessor properties, and unmet explicit prerequisites reject the entire document.
There is no wildcard, role default, automatic write-from-read implication or legacy
admin fallback. Grant objects are copied and frozen. JSON key order does not change
authority; explicit false normalizes to absence. Strings have a 16 KiB input limit.

The persisted role must still be one of the current six recognized roles. A future
scoped manager is an administrative capability set; this foundation does not invent
or start accepting a new database role named `manager` or `owner`. Admin and reception
receive no implicit grants in the canonical resolver. A separately verified owner
receives known catalogue rights only after a valid document and active recognized
subject have been loaded. Malformed owner profiles also fail closed; recovery needs
an explicitly designed out-of-band process, not a permissive fallback.

The legacy adapter is intentionally named `reviewLegacyStaffCapabilities`. Its
`legacy-review` result is **not** a canonical document or authorization context; the
strict resolver rejects it. It uses the existing parser for valid legacy outer
records, preserves known role boundaries, and reports observed overlaps and
migration blockers. `observedCapabilities` reports legacy flag/helper overlaps,
**not effective permissions across every route**. In particular PR191
`financeReportAccess` / `projectFinanceSummary` require revenue + expenses + profit
permission before a doctor receives `netMinor`; a legacy profit flag alone can be
reported by this adapter while the actual summary omits net. The report response
also requires the revenue gate, and denied fields are omitted rather than zeroed.
Do not turn these observations into effective grants or bypass composite projections.

The adapter rejects versioned documents, even malformed or unsupported
ones. There is no automatic source detection followed by legacy fallback. Unmapped
features stay unmapped; the report is not a lossless migration or a ready-to-save
profile. Never feed `findUserByUsername(...).permissions` to this adapter expecting
raw storage: that DB helper has already applied the legacy parser. Future integration
must load raw canonical JSON before any legacy defaults are applied.

## Trusted owner and separate clinical identity

`ownerContextFromTrustedBinding` is a pure trust-boundary constructor, with **no
caller in production code**. A future server bootstrap would supply a separately
reviewed immutable `users.id` binding and monotonically changing binding version
from outside staff-editable documents. This code does not select a storage system,
read environment variables, infer the first admin, search usernames or bind any real
account. A staff role, profile field or username can never make someone owner.

The context is process-local, opaque and backed by a private WeakMap. Serialized,
cloned or structurally fabricated contexts do not confer authority. This is defense
against accidentally trusting JSON, not protection from malicious code already
executing in the trusted server: code that supplies the binding is the trust boundary.
The binding is copied and frozen, and no owner-transfer operation exists here.

`users.party_id` remains the separate clinician identity. The resolver takes an
independently verified `clinicianPartyId` from a trusted user row and never derives it
from admin/doctor roles, grants or the owner binding. An unlinked account has no own
patient/appointment/commission scope. Administrative grants do not rewrite the link.
A linked doctor may hold administrative grants and remains the same clinician for
case attribution, doctor rows, visits and commissions. An unlinked owner is still
not a clinician. The future loader must validate that the referenced party remains
an active doctor, including after deactivation or relinking.

Owner-only operations are separate from document grants: credential resets, role
changes, clinician-link changes, and security/integration setting changes. Their
names are rejected as grant keys. `staff.profile.edit` means basic display/profile
maintenance only, never these authority fields. `settings.operational.edit` excludes
finance, staff authority, security, integrations and backup policy; finance settings
need `settings.finance.edit`. Existing category registries still need explicit
projection and allowlisting during integration. No capability approves destructive
operations, credential changes, or bypassing financial invariants on its own.

## Resource and delegation boundaries

- `hasStaffCapability` checks a known operational grant. It is only one gate. It does
  not check ownership, field projection, lock periods, amount limits or record state
- Patient and appointment constraint helpers return `none`, `all`, or a verified
  clinician party ID for `own`. Queries must apply these constraints **before data is
  returned**, including list totals, nested clinical fields, print and exports
- Patient view scope does not imply creation, edit, deletion or export. Appointment
  view does not imply booking, rescheduling, cancellation or capacity override
- Financial reads, collection, refunds, voids, invoice cancellation, marking paid,
  prices, discounts, price increases, own/all commissions, rate changes, reports and
  exports are separately named. An export flag never grants the source data itself;
  export routes must also require that source's read permission and record scope
- Clinical plan/X-ray/visit capabilities still need patient constraints and existing
  clinical sign-off rules. Own-commission views need the independent clinician ID;
  all-commission views do not infer one. Clinical signing is not a clinician-link API
- Every staff-mutation preflight requires non-null trusted owner bindings for both
  actor and target, with identical owner user ID and binding version. Without that
  binding, the validator cannot prove the target is not the owner and denies the
  mutation. Ordinary read-only capability resolution may still omit the binding
- Capability-change validation denies self changes, owner targets, missing/mismatched
  owner contexts, stale revisions, revisions other than exactly current + 1, unknown or
  malformed next profiles, and ungranted delegation
- Delegators cannot grant beyond their own rights or manage a target already above
  those rights. They cannot create another delegator or change a delegator peer.
  Only the verified owner can grant `staff.permissions.edit`
- One clinician's `own` patients/appointments are not a subset of another's. A
  non-owner needs `all` scope to delegate any non-none scope to another user. A
  delegator needs all-commission visibility to delegate target-specific own commissions
- Basic maintenance has a separate preflight and cannot modify owner/self/higher-
  authority accounts. Its active-account-only scope is intentionally conservative.
  Disabled-account recovery, creation, and authority-field changes need dedicated
  transactional command validation before an editor is enabled

These are pure snapshot preflights, **not** transactional write guards. A future
staff command must lock/re-read actor, target, binding version and profile revision,
validate again, write the canonical revision and audit atomically, and prevent
last-owner loss. An earlier successful preflight is not permission to commit a stale
snapshot after revocation. No function here writes those records.

## Source mapping: actual behavior versus future policy

| Area | Actual source behavior in audited tree | Future representation / migration constraint |
| --- | --- | --- |
| Roles | `lib/roles.ts:30,52-79`: six roles; admin is a string comparison; admin/reception/cashier handle money; accountant can read | Recognized roles are identity compatibility only; canonical grants deny by default; owner never inferred |
| Permission JSON | `lib/doctor-permissions.ts:280-331`: admin always returns `ADMIN_PERMISSIONS`; reception and doctor merge defaults; several other/unknown roles receive doctor defaults | Strict schema parser precedes any legacy helper; unknown roles/documents fail closed |
| Reception patient access | `lib/patient-access.ts:12`; `app/api/patients/route.ts:77-89`; `app/api/patients/[id]/route.ts:83-94`: reception bypasses shared guard and doctor-only edit/add toggles | `patientScope` plus separate create/edit; stored reception toggles alone do not enforce restrictions |
| Doctor patient scope | `lib/patient-access.ts:18-26`; patient `[id]` route `doctorBlocked(..., true)` on PATCH | Own scope requires party; legacy all-read still own-edit. One canonical read scope plus all-scope edit would broaden this, so adapter reports both and refuses automatic migration |
| Patient deletion | `app/api/patients/[id]/route.ts:188`: admin-only even when a doctor's `canDeletePatient` says true | Separate `patients.delete`, still subordinate to record scope, retention policy and destructive-operation safeguards |
| Patient ownership | `lib/db.ts` `doctorOwnsPatient` / `doctorOwnedPatientIds`: plans, visits, planned visits, primary doctor, appointments, non-declined/non-cancelled internal referrals | Reuse verified ownership semantics; a single primary-doctor equality is insufficient |
| Assistant | `lib/role-routes.ts:145-169`; `lib/patient-access.ts:13-17`: today-only visits, narrow signing/documentation | Cannot losslessly map to none/own/all. Adapter labels today and blocks broad inference; preserve existing assistant restriction until a dedicated policy exists |
| Appointments | `app/api/appointments/route.ts:48-63`: doctor sees assigned, owned-patient and unassigned appointments; explicit all toggle widens | Strict own cannot silently substitute for legacy own-and-unassigned; route-specific projection/booking guards required |
| Plans/X-rays | `app/api/plans/route.ts:32-56,96-108`; document/ceph routes call `canAccessPatient` with X-ray flags | Clinical capability AND patient constraint; reception bypass and finance-only summary projection must be accounted for |
| Financial role ceilings | `lib/finance-permissions.ts:35-56`; `lib/role-routes.ts:173-205`: cashier toggles cannot grant reports/commissions; accountant cannot write; allowlist also applies | Adapter preserves ceilings. Raw parsed flags alone are not effective route authority |
| Invoices | invoices GET/POST use role money helpers; `[id]/route.ts:56-69` reserves cancellation/manual-paid to admin; cashier proxy disallows invoice POST | Separate invoice view/create/cancel/mark-paid. Existing locked-period, cancellation and settlement invariants remain mandatory |
| Payments/refunds | `app/api/payments/route.ts:38,49`: cashier collection toggle enforced, refund admin-only; reversal receipt required | Collection never implies refund/void. Additional void capability is reserved and deliberately unmapped |
| Expenses/shifts | expense route `:50,142`; shifts route `:72,106`: per-cashier create/shift flags, admin-only void | Separate read/create/operate/void; preserve closed-shift and balanced-ledger guards |
| Prices/discounts | service route `:54` admin-only edit; `lib/price-authority.ts:45-91`: catalog price, reason, non-admin ceiling, admin-only increase | Separate service-price edit, discount, limit override, price increase; capability never removes reason or amount validation |
| Financial visibility | `lib/doctor-permissions.ts:346-378`: legacy revenue/cost/expense/profit helper flags differ. Released PR191 `lib/finance-report-visibility.ts:18-34,43-70` additionally requires revenue + expenses + profit for summary net, and omits denied fields | Adapter observations are flags/helper overlaps, not effective all-route authority. Preserve composite response projections; no broad finance/profit checkbox expands source fields |
| Commissions | `lib/commission-access.ts:20-39`: admin/accountant all; doctor requires own toggle, clinic revenue/other-account toggle may widen; party required for own | Own/all/rate-management separate. Maintain distinct user ID, clinical party ID and historical commission attribution |
| Reports | `lib/report-access.ts:108-120`: known report IDs, different reception/accountant allowlists, commission reports need additional flag | Aggregate view capabilities are insufficient alone. Preserve report-ID/projection constraints and require separate export plus source access |
| Staff | `app/api/users/route.ts:21,32`; `[id]/route.ts:18,34-55,107-128`: admin manages creation, password, role, clinical link, permission JSON; last-admin guard is outside update transaction | Delegated basic maintenance separate from owner-only commands; transactional owner/target/self/subset guards before any editor |
| Settings/audit | `lib/settings-permissions.ts:16-72`: category rights, admin writes, doctor/reception read; audit route `:25` admin only | Split operational/finance settings; owner-only sensitive categories; audit read/export separately. No security-setting activation here |
| Sessions | `lib/session.ts:7-22`; `lib/auth.ts:73-82`: password/user active/role checked; only cashier/accountant have permission-version comparisons | Every canonical-profile subject must acquire/revalidate a signed version claim; keep existing credential verification and do not trust stale client profile state |

## Revocation/version design, not current token changes

`staffAuthorizationFingerprint` produces deterministic SHA-256 material containing:
policy version, immutable user ID, current role/active state, clinician party ID,
external owner user ID/binding version, schema version, monotonic document revision,
scopes and ordered true grants. Invalid/inactive contexts have no fingerprint. It is
**not a credential, secret, session token, or HMAC**. A matching client-supplied digest
is never authentication. This slice does not change any existing token claim.

Future integration must sign the fingerprint in the server-issued session, compare
it with freshly loaded authority on every request, reject old/missing fingerprints
for migrated profiles, and invalidate all affected sessions on role/link/grant,
owner-binding or active-clinician changes. Store/recheck monotonically increasing
revision atomically, including same-permission rewrites, so revoke/regrant cycles do
not resurrect an older token. Include the verified clinician-party activity/version
in the future authoritative version input or deny an inactive party before resolver
entry. Credential changes continue to invalidate by the existing credential version.
Caches and client UI may accelerate rendering, never extend stale authorization.
Proxy-only token checks are insufficient until server and print/export paths enforce
the same fresh authority. Policy changes require bumping policy version.

## Blocking rollout sequence

1. Review/extend this catalogue and mapping; explicitly decide the unmatched legacy
   doctor read-all/edit-own, assistant today-only, report IDs, setting categories and
   finance-summary projection behavior. No auto-migration grants
2. Design/review the external immutable owner binding and recovery process separately;
   no first-admin/username/profile inference, live assignment or credential work here
3. Add raw canonical-document loading and versioned request identity. Migrate only
   after current admin bypasses and reception stored-but-unenforced toggles are removed
4. Wire complete server route/field/resource projections and domain mutation gates,
   preserving finance integrity, commission history and clinical identity. Cover all
   list/detail/print/export/nested paths, not just navigation visibility
5. Implement all-subject session revocation and transaction-time staff guards, audit,
   concurrent-edit checks and owner protection. Add real HTTP/DB tests for stale
   tokens, delegation, owner spoofing, cross-patient access and mid-request revocation
6. Only then build the permission editor and an explicit reviewed migration/rollout.
   Separately authorize any persistent access changes and Production operations

The foundation alone does **not** make manager/reception permissions enforceable in
the current app. Existing admin-unrestricted behavior and unhonored reception toggles
are release blockers for a scoped-permissions claim.

## Verification for this slice

Final focused verification: 70 new capability tests plus 15 unchanged role-route,
report-access and session-revocation tests pass (85 total). The refreshed PR191
financial-summary unit/actual-GET/page-effect suite adds 49 passing tests, making
134 combined focused tests. Focused TypeScript and ESLint pass.

Focused tests cover strict parsing, invalid profiles/roles, missing and unknown
capabilities, owner spoofing, clinician separation, owner-only operations, action
separation, bounded delegation, self/owner protection, revisions, immutable snapshots,
fingerprints and legacy boundaries. Run on Node 22:

```sh
node node_modules/vitest/vitest.mjs run __tests__/staff-capabilities.test.ts
node node_modules/eslint/bin/eslint.js lib/staff-capability-catalogue.ts lib/staff-capabilities.ts lib/staff-capabilities-legacy.ts __tests__/staff-capabilities.test.ts
```

Focused TypeScript uses the repository compiler options with only these files and
the focused test as entrypoints. No full build, PostgreSQL, HTTP, browser, migration,
CI or Production verification is claimed by these pure tests.
