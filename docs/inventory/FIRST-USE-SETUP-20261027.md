# First-use reference setup: implemented, centrally unbound

This slice prepares `/inventory/procurement/setup` and the existing procurement
HTTP endpoint for material/base-unit creation, immutable package conversion
revisions, store/transit/doctor-custody locations and explicit YER approval-limit
revisions. It creates no new table, permission catalogue, stock opening, payable
or doctor settlement. Existing no-self-approval rules remain enforced. Concurrent
reference changes use locked current versions; audit and durable outcomes share
the business transaction. Source unit/location history is not overwritten.

The actual runtime `referenceTransport` remains closed until the canonical
authority owner supplies the reviewed adapter. `ReferenceSetupAuthority` requires
opaque-session transaction revalidation, per-action decisions and a separate
historical binding verifier. `readiness.read` is a distinct semantic decision
from catalog `read`, so the central owner can enforce the required inventory and
financial-history read permissions. These strings do not add catalogue grants.
The existing journal's additional admin restriction is documented; delegated
non-admin operation is not claimed until the central helper is adapted.

The setup screen uses the clinic's existing logo, blue/orange tokens and Arabic
type in an orderly command bar, reference navigation, searchable item list and
contextual editors. Drafts and persisted commands are separate. A command's
original nonce, full payload, source identity and generation survive retries,
generic 403/409 and lost replies. Corrupt or unknown stored records are refused
without overwrite. Only an exact, complete terminal acknowledgement clears a
pending command. A generation change cannot leave the current UI permanently
busy, clear the old command or resume its execution automatically.

The count-only readiness reader uses one repeatable transaction snapshot. Missing
tables remain unknown, not zero. Rejected 0065 command receipts still count as
history. Shared supplier liabilities, unlinked supplier expenses, payments and
allocation records are preserved and counted separately; multiple allocations
do not count one payment twice. Offsetting movements or financial reversals are
not netted away. Table presence and an empty inventory are observations, not an
activation permission or migration/restore acceptance.

## Executed verification

Synthetic loopback PostgreSQL 18.6, Node 22 and Chromium only:

- Number-completion slice: 35 supplier/restore/maintenance PostgreSQL cases and
  101 domain/journal units passed; see its separate evidence document. The later
  setup change does not reinterpret that evidence as a single combined run.
- Setup core: final **13/13** PostgreSQL cases, 9.02 seconds, including a
  reference-read-only grant refused access to readiness. Synthetic authority
  injection proves core behavior, not the missing canonical adapter.
- Prior setup/readiness composition: **18/18** (12 setup plus six readiness),
  10.86 seconds. Existing procurement store regression: **19/19**, 11.29 seconds.
- Reference contract/headless hook/domain/journal units: **133/133**, 2.06 seconds.
  This predates the isolated readiness semantic-action amendment; affected
  readiness PostgreSQL and the final build ran afterward.
- Final current-source production build and TypeScript passed with captured
  process exit zero. Focused lint and whitespace checks passed.
- Actual signed-login browser checks: **2/2**, 21.93 seconds, at 390px and 1280px.
  They prove the **closed** setup screen, RTL/English direction, keyboard section
  selection, no overflow and refusal of setup/readiness writes with no ledger
  effects. They do not prove the open first-use journey. No mocked API or test
  permission grant was used. Both screenshots were visually reviewed.
- Same artifact, rollout gate off: **25/25**, 48.39 seconds, including the new
  setup page, reads and commands. No proposal schema was provisioned by requests.
- Browser page errors: zero. Four expected 503 resource errors were recorded for
  the intentionally closed setup/readiness endpoints.

An early build was superseded after hook changes. A later build failed because
the synthetic test cleanup invoked an optional pool method; that fixture typing
was fixed. Another completed build's process exit was lost during environment
transition and was not counted as final acceptance. The final rebuild above
returned exit zero. Review also corrected incomplete acknowledgements, corrupt
journal handling and generation-scoped busy state; targeted regressions passed.

The premium static audit is not a compliance pass: the global audit has 71
existing findings and the scoped inventory audit has seven in untouched
InventoryOverview/SupplierFinancePanel code, with none reported in the new setup
surface. The complete module redesign and open-form browser journey remain
unaccepted. Actual screenshots are local evidence under
`/workspace/inventory-resume-evidence/reference-browser/`; exact commands and
failure provenance are in `reference-setup-handoff.md` in that evidence directory.

## Remaining integration boundary

The next step is the exact canonical session/capability/subject/restore adapter,
then a real open setup → request → independent approval → receipt/match → invoice
and payment → issue/return/consumption journey through screens. The parent's new
local foundation was reported as `b4ceb777`, but its first GitHub lookup returned
no commit while upload was in progress. No alternate branch was imported.

Supplier intent/rejection source-generation provenance must remain independent
from target-owned active generation history. The source-S/target-T restore case
is still pending, as documented in the recovery requirements; it is not proved
by the old independent-authority restore pass. Exact 0077 payable-guard composition
also remains untested. Migration names 0083–0086 are reserved only; 0087/0088
remain unallocated, unaccepted and unregistered. This setup slice needs no new
migration number. No deployment, merge, live activation or automated financial
settlement is authorized by these results.
