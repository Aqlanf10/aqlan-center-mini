# Operational inventory completion

## Verified starting point

Continue the existing task and Draft PR #481 on
`feat/inventory-continuation-20261026`. The clean starting head is
`97e6a7dce698d869dd1c023b3eb90d4c5f26a699`, tree
`10f969c780905a6c2955569e926daddd0567f09c`. Remote main is still
`dc1be92eb17b4714d02caa32f9b6e3f848016a4f`. Its inventory work is preserved.
The prior head's successful CI proves its tested behavior, not an operationally
complete product. No new acceptance result is claimed in this plan.

The owner requires usable screens and authenticated HTTP workflows, not more
disconnected cores. Production activation, main merge, live migration execution,
Railway changes and a Staging request remain outside this task.

## Owner's first-use and administration acceptance

The owner clarified that production inventory has not been used because the
module is incomplete. Prioritize a clean first-use operator journey, not a large
historical-conversion project. This is not proof that tables are empty and does
not authorize deletion. Before activation, expose a count-only readiness check
for stock movements, purchases, supplier liabilities/payments and 0065 command
receipts. Existing shared finance/patient/authority data remains protected. If
unexpected inventory history exists, hold it for review without adopting or
discarding it; do not require historical conversion when its absence is proven.

The owner's top criterion is granular permission control from administration and
coherent integration with the rest of the clinic. Central authority must govern
request creation, independent approval, receiving, issue/return, supplier invoice
posting, payment/reversal, stock adjustment and report/cost access. UI visibility
must follow the server's current permitted actions, and each action must be
revalidated inside its transaction. A legacy-admin-only implementation or hidden
buttons is insufficient. Preserve approval limits, no-self-approval rules,
mandatory audit and financial bounds. The local roles team owns the central
catalogue and administration controls; inventory binds to it without inventing
new role definitions or broad grants. End-to-end acceptance must reconcile
suppliers/payables/cashbox, doctors, actual visit consumption and reports without
duplicate entries, duplicated debt or duplicated cost. No AI feature is part of
this deterministic integration.

## Interface acceptance

Use an orderly Microsoft-style enterprise layout while retaining the clinic logo,
blue/orange tokens, Arabic typography and spacing. Implement clear navigation, a
restrained command bar, searchable/filterable tables, visible lifecycle statuses,
consistent forms and contextual details. Preserve pending drafts and command
evidence, RTL, keyboard access and responsive actions without hidden overflow.
Permitted actions and explanatory refusal states follow central authority.
Acceptance requires actual synthetic desktop/mobile browser screenshots, not
mockups or color-only changes.

## Concrete dependency list and order

| Dependency | Existing evidence | Implementation needed | Acceptance before proceeding |
|---|---|---|---|
| Canonical identity and authority | Parent owns deferred 0076 canonical realm, opaque session and capability contracts; exact source transfer is blocked. The published independent realm proposal is held and not accepted. | Consume the central adapter and transaction revalidation. Account continuity across restore requires a centrally governed subject/provenance binding; equal numeric IDs or v1 locator keys are insufficient. No competing realm or role catalogue. | Real login, owner/delegates, granular grants and revocation, account-ID reuse, historical held commands and target-owned restore generation; exact composed source required. |
| Supplier finance through the product | Revision/post/full-unpaid-cancel cores and existing operations screen are present. | Add version/digest-bound HTTP dispatch, effective financial status, invoice review/revision/post/cancel controls and source-linked navigation to the existing payment workflow. | Browser creates one payable, retry/lost response creates no duplicate, audit failure has no effects, payment blocks cancellation until authorized reversal; mobile/desktop screenshots. |
| Durable command compatibility | v1 browser journal and prepared admission/retirement core exist; neither proves missing legacy provenance. | Persist fresh intent before admission, recover a lost admission reply, share the existing execution key/lock, retain old records visibly, and add explicit terminal handling with durable evidence. | Reload/two-tab/admission/execute/retire races; 403/409 and permission changes preserve exact keys and bodies; independent new intent does not erase an older uncertain operation. |
| Schema and managed restoration | Proposals are unnumbered. The actual application restore rebuilds schema then INSERTs backed-up rows. | Coordinate migration numbering, integrate contracts, preserve identity/history, rotate execution epoch for managed restore/reset/clone, and make backup dependency/row ordering honor immutable guards. | Forward install and actual application backup/restore on synthetic data, not just pg_dump; old browser commands cannot execute against rolled-back history. Out-of-band physical restore is not claimed detectable. |
| Operable reference data | Tests currently seed package versions, locations and approval policy. | Add authorized setup/read/edit-by-new-version controls using registered items/suppliers/doctors and explicit policy inputs. Finish historical quarantine exit and any missing order-amendment controls. | A clean operator journey works through screens without SQL fixture provisioning of business reference data; no self-approval or implicit limit. |
| Partial supplier returns and reversals | Receipt, lots, accepted reservations and full unpaid invoice cancellation exist. | Source-linked partial physical returns and corresponding financial credit/reversal, concurrency guards and immutable history using existing quantity/debt/cash ledgers. | Return only eligible available quantities, conserve native/frozen base value, prevent double return/credit, serialize with payment/consumption, roll back on audit failure. |
| Patient/visit and doctor consumption reporting | Verified custody consumption and sourced read-only cost core exist. | Integrate a patient/visit selector and read-only financial authorization with existing patient-access rules; show actual consumption, returns, missing costs and historical attribution. Complete source-linked correction/reversal. | Wrong patient/visit/doctor and revoked access refuse; no cost for unissued/unused stock or service-name inference; amounts reconcile to original invoice/usage evidence. |
| Complete usable journey | Isolated slices and existing gated UI have tests. | Compose request → independent approval → order → inspection/receipt → match → payable/payment → clinic/doctor issue → actual patient consumption → unused return and permitted reversal. | One synthetic signed-session browser journey plus stale-preview, concurrent receipt/payment, lost response, audit failure, permission and managed-restore cases; exact-head CI and reviewed 390px/1280px evidence. |

Each cohesive slice is implemented and tested before the next dependent slice.
The first usable slice is supplier invoice review/post/full-unpaid-cancel in the
existing operations workspace, including the authority and recovery it needs.
Other engineering dependencies continue while a business-policy answer is pending.

The [2026-10-27 supplier slice evidence](SUPPLIER-OPERATIONAL-20261027.md)
records its implemented HTTP/UI and successful synthetic desktop/mobile,
recovery and actual managed-restore tests. It does not close the remaining rows
in this plan or authorize deployment.

## Shared ownership and numbering

Do not import or edit unrelated PR #482 or current-doctor appointment work.
Keep lab screens, owner definitions and payroll writers under their existing
owners. The shared identity and restoration edits are narrow integration hooks,
not a parallel authentication or permission system.

Migration numbers 0070–0082 are unavailable. The parent has now reserved
`0083_inventory_procurement.sql`, `0084_inventory_custody.sql`,
`0085_inventory_supplier_finance.sql` and `0086_inventory_command_lifecycle.sql`
for this task. This reserves filenames only, not acceptance or activation.
Numbered SQL/runtime registration has not yet been materialized. 0087/0088 remain
HOLD, UNACCEPTED and NOT RESERVED. No proposal is applied to a live service.

On 2026-10-27 the parent reported candidate
`6c2adca6be3615ce6d87ee097bc456de1525179a` for separate PR #482, registering
0074 and 0078–0082; older 0073/0075/0076 authority reservations also remain.
The [exact unnumbered proposal manifest](proposals/migration-manifest-20261027.json)
lists the checkpoint's six sources and the later official-number companion,
with exact tables, functions, views and dependency order. An assigned number
alone does not approve a competing identity contract or activate a migration.

The parent confirmed that reserved 0076 at local
`b4a65c2ec9f4b686ac483d4d8cc5744f8cd28ad5` already owns the canonical realm in
`staff_authority_control`, user authorization epochs and owner recovery.
Its principal key is SHA256 of `['staff-principal-v1', realmId, userId]`.
The independent identity proposal in checkpoint 45447909 is therefore
**unaccepted and must not be activated**. The inventory adapter must consume
the opaque canonical staff session, transactional revalidation and central
inventory/finance capabilities, allowing legacy behavior only when that canonical
control explicitly permits it. A target-owned inventory execution generation
may be separate from authorization epochs; it cannot create another realm or
user identity.

Canonical 0076 restoration retains target authority, excludes source authority,
quarantines before data replay and requires explicit owner recovery. The proposed
source-realm-preserving restore cannot be retained as its substitute. Old source
business roots and unresolved commands must remain immutable and quarantined;
terminal lookup requires an explicitly reviewed provenance binding.

The parent also reserves 0077 for manual payable command identity on
`finance-next-atomic-audit` at reported head `4c1ab8fb`, proposal
`docs/proposals/0077_manual_payable_command_identity.sql`. Supplier payable guards
must be composition-tested against its exact columns/guards without replacing
them or rewriting 0065. The parent confirms the GitHub 404 was expected because
these references are local-only. Private reference
`libfile_e6348e6adc108191a65bbc356eab9bbd` was prepared through Library twice;
both supported download attempts failed with `download failed`, leaving no local
file. A native Library text read of the archive returned no readable content.
The exact canonical session/capability/restore sources and 0077 SQL therefore
remain unavailable here; no substitutes or guessed imports are accepted.
Current-baseline tests do not prove the future composition. Independent invoice
completion work continues while the parent supplies readable exact references.

## Business-policy questions that do not block tracking

Existing accounting is already defined in `lib/materialRate.ts` and the doctor
commission reader in `lib/db.ts`: configured specialty percentages apply to
collected amounts, using the original payment-time rate and linked refund
allocation. They are not inferred from actual stock consumption. The existing
`finance.commission_material_rate` setting controls subtraction from calculated
commission, with a source default of `off` (no claim about live settings).
`netEarnedMinor` is floored at zero; the existing derived `dueMinor` may be negative
when recorded payouts exceed that entitlement. Inventory does not change those
rules or erase an existing payout balance. The computed `materialRateCostMinor`
is not by itself proof that a separate deduction was posted for a settlement.

Recording actual quantities, evidenced patient/visit attribution, supplier debt,
eligible returns and reports does not require creating doctor liability. Those
engineering flows continue. Before any doctor financial comparison becomes an
approved settlement, the owner must specify:

1. The covered material categories and applicable doctor agreement/version.
2. The comparison period and whether a new agreement intentionally changes the
   existing collections-based rule. The present rule needs no reinvention.
3. Which existing posted deduction and linked reversal entries constitute the
   comparison amount; a theoretical percentage is not a posted deduction.
4. Who may approve a difference and which existing financial writer may post it.
   Positive or negative variance alone authorizes neither debt nor refund.

These policy questions do not block completing authorized quantity and recorded
consumption reports, which stay separate from an unapproved charge. The current
patient-cost reader still lacks its canonical HTTP/UI binding and is not claimed
usable through the product. Missing historical attribution or valuation is shown
as missing, never inferred or replaced with zero.

## Evidence discipline

Preserve center branding, existing navigation, blue/orange palette and bilingual
Arabic/English controls. Verify loading, empty, refused, uncertain and confirmed
states at desktop/mobile widths. Use synthetic loopback data only. Record each
slice's exact tested source, observed browser behavior and remaining gaps here;
do not transfer the previous head's green result to changed code.
