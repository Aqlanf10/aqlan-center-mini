# Rx history and durable issuance v1

## Scope and retained invariants

Issued prescription history is not pharmacy dispensing evidence. Clinical history is available only to freshly verified active linked clinicians within patient scope. Reception's existing explicit reprint grant remains a minimal active-only picker. Stored name, strength, actual per-dose amount, instructions, date, visit and state are displayed without clinical recalculation; old missing names are not invented. Void rows have no reprint link, and existing server print/log guards remain authoritative.

No dose calculation, owner-delegation activation, doctor permission grant, financial write, live data manipulation, deployment or AI feature is included. Existing 0090/0091/0092 SQL is unchanged.

## Issuance command

POST requires a UUID-v4 `commandKey`. Missing/invalid keys receive `400 issuance_protocol_required` with no write; old browser clients must reload. Server SHA-256 binds protocol version, actual actor ID/username, patient, visit, selected doctor ID and normalized clinical payload including reviewed per-dose amount. Transient safety tokens, current registry name, timestamps and current warning state are excluded from the command hash. The issued doctor name and accepted warning fingerprint are persisted separately.

One PostgreSQL transaction reserves the unique command, revalidates authority, then either returns the existing Rx or checks current safety and writes Rx + audit + completed receipt. There is no separately committed pending lease, TTL, reclaim, receipt deletion or automatic new-key retry. A deferred constraint checks the final receipt at COMMIT, including its patient/visit/actor association; completed receipts cannot be reassigned, edited, deleted or truncated. Exceptions roll back all three writes. An uncertain COMMIT is reconciled by retrying exactly the same command.

Lock order: command uniqueness/row, canonical session user SHARE (credential/version/role/expiry), sorted clinician parties SHARE NOWAIT, optional visit SHARE NOWAIT, patient SHARE NOWAIT, patient-scope witnesses SHARE NOWAIT. Permission checks run after any unique-key wait. Contention/deadlock returns a same-command retry response. Current Rx state is re-read under SHARE NOWAIT on replay; no stale active result is cached.

Replays bypass *new issuance* safety acknowledgement, including expired tokens, only after fresh authority checks; they do not create or automatically print anything. New attempts always check current locked patient alerts and current signed acknowledgement. A completed visit is not grounds to erase or hide its issued Rx.

## Browser and recovery

Session storage contains only opaque UUID, digest, protocol version and clinician ID under actor/patient/visit scope—never medications, diagnosis, instructions, name or signed safety tokens. It survives tab refresh. Storage failure fails closed before sending. A synchronous in-flight latch and generation token fence delayed hashing, POST, recovery, UI effects and print effects when the modal closes, unmounts or changes patient/principal/context. Double clicks cannot allocate a second key.

Recovery GET uses signature-only session admission, followed by transactional fresh authority; it performs no DDL/DML or schema initialization. Missing receipt means unknown/in-flight, not proof that issuance failed. Recovery and POST replay expose a user-driven saved-document link, never automatic printing. Network/server ambiguity never automatically opens a draft or allocates a fresh key. Explicit new issuance requires a warning/confirmation that the prior Rx may already exist and that the patient history must first be checked; this discards only the local reference, never server history.

## Deployment gate — no mixed old/new issuance servers

**Do not enable this client while any preprotocol server can handle POST /api/prescriptions.** The old c4 server ignores commandKey and can duplicate same-key retries. Drain/replace all old issuance instances (or first deploy a compatible server-only protocol), verify every serving instance rejects keyless writes and enforces durable replay, then enable the new client. Rollback to a preprotocol application must keep issuance disabled; it is not a safe automatic rollback. Preserve 0093 and completed receipts in backup/restore. No production deployment is authorized by this source review.

## Reset and restore

Receipts are explicitly KEEP history. Existing reset admission remains unchanged, but any receipt makes reset refuse with typed `409 protected-prescription-history` before backup/deletion/file cleanup. EXCLUSIVE table locking prevents concurrent issuance from invalidating the check. Only an empty, locked receipt table participates in the existing reset TRUNCATE to satisfy its Rx FK; the table-level trigger independently rejects nonempty TRUNCATE. No history can be wiped through this path. A future archival/reset policy needs separate explicit design/approval.

Both official SQL and full archive restore must preserve Rx, completed receipts and audit; replay after restore must return the original Rx. Migration source/ledger/catalog drift fails closed. Native PostgreSQL 18 schema-contract regeneration and full restore/race CI are release gates, not inferred from in-memory smoke.

## Evidence status

History-only local commit 216b1dec / remote Draft #504 has 46 focused tests and touched ESLint passing; PG query tests prepared. Receipt focused in-memory SQL and protocol/UI tests exercise rollback, uncertain COMMIT, replay, revocation and owner retirement; these are not real multi-connection PostgreSQL proof. Hosted PG18 tests are prepared for uniqueness races, blocked revocation, NOWAIT, audit rollback, restore/replay and reset refusal. Local PG18 was not run: free disk is below the owned runner's 4 GiB safety guard. Full local typecheck was killed by resource limits; hosted typecheck remains required. No guard was bypassed and no prior database/evidence was deleted.

### Final patient/visit identity dependency inventory (scope frozen)

- Patient deletion already refuses any prescription clinical history; retained unchanged.
- Source patient merge now refuses when the source has completed issuance commands, after sorted source/target patient UPDATE locks and before any FK rewrite. Target-only command history and legacy Rx without commands retain the existing merge behavior. No receipt is moved or adopted.
- Visit deletion now refuses a command-bearing visit under its existing UPDATE lock, before soft-link cleanup; otherwise ON DELETE SET NULL would erase the saved visit association.
- Visit reparenting now refuses changing the patient of a command-bearing visit under its existing UPDATE lock. Same-patient relinking and no-command operational visits retain existing behavior.
- Null-only patient attachment cannot affect an issued command, which requires a matching existing patient/visit. The only direct Rx mutation remains the existing audited void path. Doctor registry changes do not rewrite the saved prescribing snapshot.
- These are deliberate protected-history limitations, not a claim of complete archival/merge functionality. No live merge, relink, delete or reset was executed. A future way to reconcile immutable issuance history across patient merges requires separate explicit design and approval.

Native multi-connection tests must establish both writer-first refusal (issuance NOWAIT/no partial write) and issuance-first protected-history detection after waiting. The application checks rely on the patient/visit locks already used by issuance, not on an unfenced preflight count.

Final local receipt tranche evidence: 30 focused files / 387 tests passed on the frozen candidate, including the actual-route fail-before/pass-after regression, in-memory SQL transaction/deferred-trigger tests, UI owner/latch tests, protection cases, migration-chain checks and artifact-gate test. Touched-source ESLint completed with zero errors and three React effect warnings (one existing prescriber-load warning and two explicit owner/storage synchronization warnings). This does not substitute for hosted TypeScript/full CI, PostgreSQL 18 multi-connection races, native schema contract or official restore execution.
