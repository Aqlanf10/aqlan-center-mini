# Governance and numbering integration checkpoint

This source combines the public governance checkpoint `e01d667f` and its reviewed
local compatibility and waiting-room work `8a3e48a` with the published numbering
review snapshot `69e8ea92`. Numbering's source delta is composed against
its exact published Stage parent `97724c2`; this is not a merge or deployment into Stage.

- Migration 0080 and its legacy `aqlan_allocate_patient_number()` default stay
  unchanged. Manual creation, walk-in, import and booking use it in the absence
  of an explicit synthetic allocation scope. No managed owner settings are
  mounted; legacy numbering stays read-only and renames remain unmounted.
- Legacy and new archive P metadata are evidence, not executable SQL. Old exact
  writer syntax is stripped and read as typed state; mixed, malformed and
  repeated values are refused. Same-byte and history checks run before the
  dedicated administrative reset; 0090–0093 remain unsupported history.
  Reconciled sequence state is read back in the replay transaction.
- Successful isolated restore is not cutover readiness. Canonical archives
  require the full staged restore on a genuinely fresh target; the repeating
  administrative reset cannot be used to erase an authority footprint first.
  The full staged path retains R1 quarantine and R2 pending permission behavior.
- Governance's active staff auth and authority stay in place. The older
  numbering snapshot's competing staff-writer and legacy-session fixtures are
  not installed or claimed as evidence on the combined authority base. Synthetic
  numbering fixtures use the actual v2 permission envelope, not relaxed parsing.
  An actual canonical, same-client owner binding and activation remain separate.

Review source only. This checkpoint does not establish full-project CI,
browser/TV operation, Stage schema/rollback compatibility, or deployment readiness.
