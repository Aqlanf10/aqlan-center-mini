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

## Concrete dependency list and order

| Dependency | Existing evidence | Implementation needed | Acceptance before proceeding |
|---|---|---|---|
| Canonical identity and authority | Signed sessions and `revalidateSessionInTransaction` already validate account/credential/role under a transaction-held user lock. There is no persisted realm/subject in this base. | Add durable server identity to existing authenticated users, explicit initialization and signed binding; reuse the current management policy. No future capability catalogue or new broad grant. | Real login, missing/old claims, role/credential revocation, concurrent authority change and cross-realm/epoch refusal. |
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

Migration numbers 0070–0082 are not available for this task without coordination;
the parent specifically reserves 0074 and 0078–0082. A numbering request is pending.
Continue with unnumbered proposals and disposable test installation until the
owner assigns the final number/range. No proposal is applied to a live service.

On 2026-10-27 the parent reported candidate
`6c2adca6be3615ce6d87ee097bc456de1525179a` for separate PR #482, registering
0074 and 0078–0082; older 0073/0075/0076 authority reservations also remain.
The [exact unnumbered proposal manifest](proposals/migration-manifest-20261027.json)
lists the six current sources, proposed basenames, dependency order, all 39
tables, 10 SQL functions and two views. The parent must compare the proposed
realm/subject/execution-epoch contract with its reserved authority work before
registration. An assigned number alone does not approve a competing identity
contract or activate a migration.

The parent also reserves 0077 for manual payable command identity on
`finance-next-atomic-audit` at reported head `4c1ab8fb`, proposal
`docs/proposals/0077_manual_payable_command_identity.sql`. Supplier payable guards
must be composition-tested against its exact columns/guards without replacing
them or rewriting 0065. The pinned GitHub read returned `404: No commit found`,
and that object is absent in this checkout. This future composition is pending
source availability; current-baseline tests do not prove that composition.

## Business-policy questions that do not block tracking

Recording actual quantities, evidenced patient/visit attribution, supplier debt,
eligible returns and reports does not require creating doctor liability. Those
engineering flows continue. Before any doctor financial comparison becomes an
approved settlement, the owner must specify:

1. The covered material categories and applicable doctor agreement/version.
2. The period and whether the contractual depreciation percentage applies to
   collections, commission or another explicitly defined base.
3. Which existing posted deduction and linked reversal entries constitute the
   comparison amount; a theoretical percentage is not a posted deduction.
4. Who may approve a difference and which existing financial writer may post it.
   Positive or negative variance alone authorizes neither debt nor refund.

Until then, quantity/known-consumption reports remain usable and explicitly
separate from any unapproved charge. Missing historical attribution or valuation
is shown as missing, never inferred or replaced with zero.

## Evidence discipline

Preserve center branding, existing navigation, blue/orange palette and bilingual
Arabic/English controls. Verify loading, empty, refused, uncertain and confirmed
states at desktop/mobile widths. Use synthetic loopback data only. Record each
slice's exact tested source, observed browser behavior and remaining gaps here;
do not transfer the previous head's green result to changed code.
