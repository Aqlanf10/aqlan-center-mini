# Radiology requests — review tranche (0094)

## Scope and operation
- Central settings → مراكز الأشعة: UUID-addressed name/address/active catalog; empty by default, structured editor and existing clinical-settings CAS/permissions.
- Patient file → طلبات الأشعة: current self-linked active doctor authors an examination, anatomical region and optional recipient instructions. Optional visit must belong to the patient. No diagnosis generation, results entry, billing or external transmission.
- Issue creates one immutable document/command receipt and awaited audit in one transaction. Key advisory lock precedes fresh credential/role/patient authorization; downstream scope locks use NOWAIT. Same actor/key/scope/payload replays the same document, not a new issuance.
- Current-account admin status is not clinical/owner delegation. The separate protected owner-authority work is not activated here.
- Reception has **no default grant**. An authorized administrator may explicitly enable `canPrintRadiologyRequests` under users. It permits only minimal scoped history and saved printing, never clinical authorship/options/edit.
- A6 (105 × 148 mm) print is scoped to this document. Stored clinic/patient/doctor/recipient fields, clinic-zone issue time, no live rename substitution. Ordinary A4 reports are unchanged. Overflow must be verified on real PDFs; no fixed content clipping or shrink-to-fit.

## Recovery / operator instructions
The browser stores only an opaque command key under the actor/patient/visit scope (no request text, names, medical notes, credentials or tokens). In-memory retries retain the exact original payload. Storage failure blocks submission. Reload with a retained key blocks new issuance and offers authoritative recovery/history. A missing receipt is **unknown**, not evidence of rollback. Recovery/replay never auto-prints. The app-controlled print button performs a fresh narrow POST authorization and awaited audit before window.print; errors or retired page scope never print. Browser-native Ctrl+P on content already disclosed cannot be revoked remotely.

A clinician may explicitly choose “بدء طلب مستقل بعد مراجعة السجل” and confirm the warning that the prior request may already exist. This removes only the local reference and clears the draft; it neither deletes a server receipt nor automatically creates/submits a replacement. This is a documented **new-intent reconciliation**, not exactly-once recovery of lost draft contents. There is no server cancellation/terminal-rejection command in this tranche.

## Retention / archive
0094 uses immutable issued rows, patient/visit/doctor RESTRICT references, exact snapshot identity/shape checks and a populated-TRUNCATE guard. Source-patient merge, visit delete/reparent and clinical reset explicitly refuse protected history under existing writer locks. No historical rebind. Dynamic SQL/full archive export must retain rows and migration registry. Native restore/replay tests are required before acceptance.

Runtime and CLI migrate both validate exact source/registry provenance and existing catalog before skipping/adopting anything. Unregistered residue is refused. Migration 0090–0093 bytes are untouched. Schema contract and ownership snapshots must be generated from hosted native PostgreSQL; **no hand-edited generated evidence**.

## Evidence / acceptance gates
Local focused unit/actual-handler tests cover central CAS/permissions, parser/decoder, fresh authorization, exact replay/collisions, atomic wrapper rollback, lost-response/reload recovery and minimal reception access. Bounded PGlite tests demonstrate SQL-shape compatibility/catalog validation only, not native locking or official restore.

Pending hosted gates:
1. Full typecheck/build, migration/provenance/ownership consistency and source-generated actual-schema artifacts.
2. `__tests__/postgres/radiology-requests.test.ts`: native same-key concurrency, writer-first NOWAIT, issuance-first real writer wait, immutable/reset protections, official SQL/full archive restore + replay.
3. `__tests__/print-visual/radiology-request-a6.test.tsx`: actual page dimensions, short and long Arabic text, continuation identity and PDF text bounds. Do not claim A6 overflow acceptance until this passes.
4. Built-app authenticated HTTP/role and settings/patient workflows against synthetic data, including revoked grant, patient/visit mismatch and direct print URL.
5. Independent final source review, sole-publisher Draft PR/CI. No live settings/grants, deployment or data mutation as part of implementation.
