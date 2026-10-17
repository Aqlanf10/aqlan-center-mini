# Local phase 2 — under verification, not authorized for push or deployment

Remote Draft PR343 remains at 5910878f. Local checkpoints 25798c93 and fded41f2
contain the append-only schema and operational writer. The parent authorized
migration 0063 after checking 360 remote heads. No HR0062/PR342 work was used.
The parent explicitly requires keeping subsequent work local until review.

Implemented:
- Exact registered migration/runtime 0063: immutable noncash document and one
  proven event per original receipt, including refunds; source receipt rows,
  numbers, FX and cash remain unchanged. Missing/foreign/ambiguous evidence fails.
- Admin preview and writer for YER -> SAR using each recorded SAR receipt amount;
  immutable acknowledgement, request/actor/body binding and replay protection.
- Full coverage and exclusive ownership of per-procedure plans; shared plans,
  agreements, unsupported source types, quantity/identity changes are rejected.
  Plan/item/case/visit identities are retained; no duplicate clinical treatment.
- Paid commission expenses for affected doctors and any non-reversed payroll
  commission block this narrow first release. This conservative payroll guard
  can block an unrelated doctor; it never silently reprices approved payroll.
- Settlement, account, debt, repayment, checkout, treatment finance, portal,
  printing, reports and commission consumers use verified allocation evidence.
  Historical report cutoffs retain source currency before the correction.
- General ledger preserves original receipt entries and appends dated balanced
  noncash reclassification and original-invoice reversal entries.
- Refunds append one negative event; receipt correction replacements follow the
  current SAR invoice. Receipt/shift fences avoid the observed refund deadlock.
- Restore dependency ordering loads original receipts before immutable evidence;
  schema contract, ownership and preflight disclosure regenerated from synthetic
  PostgreSQL source schemas only.
- Recovery UI retains saved request/journal and displays blocked/busy/rejected
  outcomes; retry is explicit, with the original key and body.

Verified locally so far (synthetic PostgreSQL18.6 only):
- Real writer2500YER ->2500SAR: settled900SAR, due1600SAR, independent100YER
  credit; full original receipt fingerprint unchanged; replay creates no money.
- Account/debt/checkout/report/daily clinic/GL agreement; partial refund and
  receipt correction; full refund repeated under one key produces one event.
- Commission270SAR for900SAR settlement, zero after full refund; historical
  pre-correction commission750YER remains unchanged for its historical cutoff.
- Missing/forged evidence, destructive writes, shared coverage refusal,
  clinical identity preservation and exact backup/restore plus later refund.
- Actual Arabic HTTP/UI at390 and1280: lose committed response, reload and
  explicit retry; one correction, unchanged receipts,1600SAR visible in print.
- Snapshot composition25 tests passed, but parent is reviewing follow-up
  rollback disposal/PGlite compatibility; that portion is not final.
- Updated private temporary report schemas and schema ownership:36 tests pass.

Still required before release claim: finish full frozen regression (unit,
PostgreSQL, HTTP), final typecheck/lint/build, integrate parent's reviewed
snapshot cleanup, and review multi-query read consistency beyond debt rows.
Evidence logs currently in /tmp/currency-*.log; final consolidated evidence and
screenshots will be added after the frozen run. Prior verification.md describes
phase1, not a complete phase2 release. No production data or stopped staging
was accessed or started.
