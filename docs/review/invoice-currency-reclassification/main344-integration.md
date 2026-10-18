# PR344 main integration

Merge parents: PR345 head3bec33494c9da03e2ed09b875eabc01f9e5098a3 and
main a3b3049f7d0e37dfb383beac555f4391602190d7. No force push.

No textual conflicts occurred. lib/reports.ts is byte-identical to PR345's
pre-merge version (Git blob a37ff14c84d9adab191e2280eb6761a44b311fc0), which already
contained PR344's per-component cutoff. The merge brought its two test files and
documentation. Currency allocations and snapshot reads remain intact.

The newly imported read-failure test initially failed on PostgreSQL because it
intercepted pool.query, while reports now read via the snapshot client. Its fault
injection now covers the shared PGlite runner and the PostgreSQL snapshot client,
preserves native pg connect(callback), forwards release(destroy), and asserts
exactly one injected failure plus the original rejected-report outcome. Test-only
adapter iterations were not counted as successful verification.

A new composition test proves old YER billed/paid/due components remain2500/410/2090
before and after today's correction, with the full historical debt rows unchanged.
A cutoff before the old receipt gives2500/0/2500. Current SAR components are
250000/100/249900minor, then250000/75/249925 after a25minor refund. A future SAR
invoice and receipt remain excluded. Correction preserves the original receipt
JSON, and the later refund does not alter the old cutoff.

On the composed tree:110 PostgreSQL tests across8 files pass (debt cutoff, annual
boundaries, expense comparison, currency schema/settlement/revision, debt and
patient-ledger snapshots);35 unit tests across5 files pass (cutoff, snapshots,
statement loader, currency arithmetic). Typecheck passes. Full lint:0 errors,
208 existing warnings; final changed tests also pass targeted lint. Money scan
and git diff whitespace checks pass. Full remote CI is still required on the
merge head; no previous full-suite result is attributed to it. No live data,
deployment, staging start, schema gate weakening or PR342 integration occurred.
