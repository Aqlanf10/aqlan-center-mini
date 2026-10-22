# PR #390 — dated, append-only treatment upgrade (Draft; NO PRODUCTION DEPLOY)
Base: `2667b71f815ee14781cdac6b37ebad3b4f8e246d`. Branch: `feat/agreement-delta-amendment-20261021`.

## Supported scope
- A single-item, explicitly approved, invoice-funded agreement; a **positive same-currency** replacement of the selected service/unit price. Other situations remain blocked for financial review, not inferred.
- `migrations/0066_agreement_delta_amendments.sql` and the byte-identical runtime SQL define an immutable event, difference-only invoice and line, immutable split-collection receipt, and an immutable **stale-attempt rejection**. No alteration to the original invoice, historical payments, signed clinical work, settled payroll, or old commission history.
- The upgrade writer validates the entire source and admin authority while holding patient/visit/shift/plan fences and a per-idempotency-key PostgreSQL advisory transaction lock. The same-key retry returns the original verified receipt.
- When a payment changes the source between preview/save: the writer commits a **rejection record** keyed to actor, original body digest, plan and observed source hash; it does *not* post a difference invoice. The status `PUT /api/plans/[id]/agreement-amendment` authenticates an active admin and waits for the same key lock before returning one of:
  - `committed` with the immutable receipt;
  - `rejected_stale` with the committed rejection evidence (only case in which the UI enables a new preview and key);
  - `unresolved` (absence alone never clears a possibly in-flight or delayed write).
  - 401/403/409, lost reply, role switch or status transport failure never discard the saved request.
- `PatientPlans` chooses the plan source when a delta exists. `/api/payments` returns a verified composite receipt with **every** invoice allocation, payment row, and print ID. Replayed requests return the same receipt IDs; the client requires all parts to match before acknowledging. Never display 320,000 as the full 620,000 collection.
- Commission decision uses existing dated doctor/service/case policy and primary doctor fallback. Missing **required** incremental cost evidence blocks automatic doctor earnings. Other policies need no invented cost. No retroactive change to previous commissions.

## Acceptance and source-of-truth
- `.github/workflows/pr390-acceptance.yml`: exact PR HEAD, real PostgreSQL 18, quote/schema, source/currency regressions, Next.js production build and Playwright browser against a synthetically seeded server.
- `__tests__/postgres/agreement-delta-amendment.test.ts`: one 300,000 difference, total 800,000, paid 180,000, 620,000 collected once as **320,000 + 300,000**; replay/concurrency/rollback, refund and doctor, durable stale proof, locked in-flight status.
- `__tests__/security-http/agreement-delta-upgrade-ui.test.ts`: server-backed preview→intervening payment→stale proof→refresh→single save, lost **amendment** response after DB commit + actor switch + UI retry, exact printed amount and invoice number on both receipts, and nonempty historical statement.
- `package.json` / `package-lock.json`: Vitest and its @vitest packages (including mocker) pinned to 4.1.12 with SHA512 integrities. No changes to security audit rules, policy exceptions, or vendor patches.

## Guardrails, known limitations and rollout
1. Continue to restrict nonpositive upgrades, multiple items, opening-source/unproven allocation, foreign-currency splits and any ambiguous funding. No broad finance redesign.
2. **Draft means no merge/deploy.** A passing targeted suite is not equivalent to a green full CI, review of source ownership, or a staging rehearsal.
3. Migration 0066 is an additive SQL-only schema addition, no backfill or old-data rewrite. Before rollout compare migration registry/checksums, schema preflight, active connections, and backups. Reverting the app after *live* writes requires forward-compatible reads/retain 0066 evidence, not dropping rows or reversing receipts.
4. Only synthetic patient/test DBs and public repository sources may be used. Do not change Railway, production data or secrets.
