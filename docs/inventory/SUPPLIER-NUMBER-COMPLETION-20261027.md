# Official supplier invoice number completion

An invoice entered without its official number can now receive that number in
the existing reviewed revision editor. The original document and missing-number
reason remain immutable and visible after posting. The established supplier,
year, currency, order and branch identity remains fixed; a known number cannot
be replaced by a different canonical number.

The unnumbered `INVENTORY_SUPPLIER_NUMBER_SQL` companion creates
`supplier_invoice_number_claims`. Both original invoice matching and later
revisions reserve the same existing normalized duplicate key, including Unicode,
case and whitespace normalization. Concurrent actors, keys, orders and the old
matching path cannot claim a number for different invoices. Claims, revision,
audit and replay result share the existing transaction; no new payable or stock
ledger is introduced. Completion refuses if the source-claim schema is absent.

The registry is derived exactly from immutable invoice evidence.
`inventory_supplier_number_sources` defines the first known source, including
its document, actor, timestamp and actual original version. Before omitting
derived registry rows from backup SQL, the backup writer verifies bidirectional
equality against that projection and refuses drift. Original/revision INSERT
triggers reconstruct the same rows on restore. Nothing is silently dropped,
updated or overwritten. An original invoice above version one is supported.

The companion belongs with supplier finance registration after its base SQL;
0085 is reserved for the task, but no numbered SQL or runtime registration was
written or activated by this slice. Canonical 0076 identity/restore composition
and future 0077 payable guards remain unresolved dependencies; this change does
not broaden authority or assert compatibility with those unavailable sources.

## Executed evidence

Synthetic loopback PostgreSQL 18.6, Node 22.23.3, installed Chromium 151 only:

- Composed supplier operational, actual application archive/SQL restore and
  maintenance tests: **35/35**, three files, 35.17 seconds. Includes original
  version-two reconstruction and backup refusal before output on projection drift.
- Domain/journal unit regressions: **101/101**, two files, 1.16 seconds.
- Current-source production build and TypeScript: passed.
- Same-build browser coverage: **26 cases passed in the full run**, while the two
  new cases initially failed an exact accessible-label test locator. After a
  locator-only correction, those **two cases passed** at 390px and 1280px; eight
  other cases were skipped in that targeted invocation. This is not a claimed
  single 28/28 local run. Financial, lineage and lost-response assertions remain.
- Same-build gate-off/recovery: **25/25**, 59.04 seconds; all 40 proposal tables
  remain absent with the gate closed.
- Product ESLint: zero errors/warnings; whitespace checks passed. Screenshots of
  number review and completed posting were visually inspected. No horizontal
  overflow or browser page errors. Expected resource errors were the two deliberate
  lost-reply aborts; other aborts were navigation/prefetch cancellation.

The independent reviewer found a mismatch between hardcoded original version one
in the source projection and the actual document version used by the trigger.
It was fixed before the final 35-case composition, with an application-restore
canary. A synthetic missing-schema test lock-order stall and a backup TypeScript
cast error were also fixed and rerun; no product guard was weakened.

Exact commands and local evidence are recorded in
`/workspace/inventory-resume-evidence/supplier-number-handoff.md`; screenshots
are under `supplier-number-browser/`. Runtime artifacts are excluded from the
private source-only continuation archive. Hosted CI on the successor commit is
still required. The remaining first-use, permissions, returns and consumption
work is tracked in [the operational plan](OPERATIONAL-COMPLETION-20261026.md).
