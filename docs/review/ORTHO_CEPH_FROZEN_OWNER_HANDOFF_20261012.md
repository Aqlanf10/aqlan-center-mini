# Owner handoff — frozen incomplete Ceph, NOT accepted

Preserved immediately on the owner's stop-and-push instruction. This branch is
storage for unfinished source, not an integration candidate or clinical clearance.

- Base: `9a25888b9312dcb148d9d9c1e52823c19d3897da`, tree
  `bb88081ca2ce5e40b8f7e8253e940d5e41775bc6`.
- Frozen code checkpoint: `61dad9eed8daac19cd773a87ad81ab48eb7f347a`, tree
  `127a4368604c37f63bb7135c1cee32a4d567dc18`.
- Branch: `handoff/ortho-ceph-frozen-incomplete-20261012`.
  This handoff is a documentation-only successor. Resolve final head/tree with
  `git rev-parse HEAD HEAD^{tree}`; remote SHA is verified in delivery.

Eight files, 402 insertions / 108 deletions, exactly byte-matched against the
previous frozen SHA256 manifest before committing. They contain proposed versioned
cephalometric plane identities and sealed-value projection, tracer/print consumers,
unit/PG/browser tests, and unfinished audit transaction changes in shared db.ts.
No file was imported into the independent presentation branch.

Known RED blockers, deliberately preserved:

- PG creation audit failure still resolves `{ ok: true, id: 2 }` instead of
  rejecting/rolling back. Creation can leave an open draft after rejected audit.
  Do not ship or import this writer. Five other audited-write fixes had passed,
  but creation is not fixed.
- Both native historical/new stamp tests (390 and 1280) fail: rendered historic
  row does not include `Historical SN–GoMe`. Historical provenance/name semantics
  remain unresolved; do not relabel old measurements as the new method.

Existing logs under `/workspace/ortho-union` are historical execution evidence,
not reruns or acceptance of this just-created commit:

- `unit-versioned-planes-full.txt`: 593 files, 10226 passed / 1 existing skipped,
  from the earlier source state before subsequent red additions.
- `pg-versioned-planes-verified.txt`: 4 files / 116 passed in an earlier run.
- `pg-ceph-create-audit-red.txt`: targeted creation test failed; eight other cases
  not selected by that run. This later red supersedes any blanket PG-green claim.
- `native-versioned-planes-first.txt`: 2 failed / 2, at 390 and 1280.
- Earlier build, lint and TypeScript logs exist; no rerun on this handoff commit.
  Owner requested credit conservation. No test or guard was disabled to save work.

Prior private frozen source archive remains Library
`libfile_5f3d349abc6481918ae3b9a488bf6cf2`; source files are now directly in Git.
No large generated evidence, secrets, signed URLs or real patient data was added.

Migration reservations: 0044 discount; existing 0045–0051 immutable; 0052–0054
Ortho study foundation; 0055 clinical governance (owner must supply source absent
from PR324); 0056–0058 separate HR; 0059 invoice debt installments. The old test-only
periodontal 0058 conflicts and requires root coordination. No placeholder numbers,
renumbering, bootstrap/catalog copying or live SQL was performed in this handoff.

Next exact step for root: inspect `9a25888b..61dad9ee`, especially the shared db.ts
hunks, against the current financial/HR owner branch. Keep those hunks deferred
until root owns their union. Reproduce the creation-audit red on guarded synthetic
PostgreSQL, fix rollback atomically, then resolve the historical label red without
inventing unknown measurement provenance. No whole-file restore from this branch.

Separate presentation reviewed base is preserved on
`handoff/ortho-presentation-reviewed-20261012` at 4fcc75e5. Its current seven-file
successor is on `handoff/ortho-presentation-wip-20261012`; that branch has no db.ts,
writer, financial, plan, migration or API changes in its successor diff. Original
reference fidelity, PPTX/PDF and full Ortho/Ceph journey remain uncleared.
No main merge, deployment, CI change or clinical operation is authorized here.
