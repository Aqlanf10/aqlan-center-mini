# Tentative next contract: durable followup-coverage command status (PUT)

This follows HANDOFF 5.3 ortho/ceph/plans and the existing mapped finance.agreements.manage patient-scoped contract. It is a status read of an already submitted exact command, not permission to create a coverage decision, invoice, payment or retrospective waiver. POST/editor remain separate until their source-write contract is implemented.

Reuse native command parser, actor-bound fingerprint, terminal committed/rejected/unresolved receipt semantics and command advisory serialization. Extract a caller-owned status reader without schema initialization or fabricated legacy session. Current canonical authority and same-patient ownership must precede receipt lookup and be reasserted after command-lock wait and before return. Existing patient/case NOWAIT order is retained. No missing receipt is called rejection; no retry/force or command reclamation is added. Response needs an explicit allowlist; full hidden source snapshots, invoice values and other actors' receipts must not escape.

Acceptance: before built401 witness; own/all/none/owner/read-without-manage, revoked/expired fence and command lock, foreign/moved owner, wrong actor or fingerprint, committed/rejected/unresolved statuses, unchanged nonempty money and clinical facts, no DDL/audit writes; legacy behavior preserved. Native trigger/schema availability remains fail closed without migration or activation. An actual writer-backed synthetic receipt may be seeded with native domain fixtures; no real record is changed.

Not started, no code claimed. If native receipt extraction cannot preserve transactional semantics, stop that component and refine before editing. No total-program readiness or release claim.
