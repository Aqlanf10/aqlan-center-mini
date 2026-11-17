# Retired 0079 and pending commission integration checkpoint

Local review branch based on `8aebc811720e72c0dd28fb21226353468bb23729`, with commission commits from `7a034ae291e1a22752b308237b05e4e44badc201` reapplied. No merge, deployment, patient or production database access is included. The both-settings-off proposal in incomplete 0134 is not part of this branch.

Real PostgreSQL 18.6, isolated synthetic server:

- Four suites passed 37 cases: pending participation/payroll and its competing-head race, grouped laboratory, lab commission lineage, and new/old retired 0079 migration/runtime validation.
- A separate new focused case passed: two dentists, one lab order, SAR/YER member prices and a manual YER total; both case decisions pending. Both doctors retained their 300-minor-unit commission accrual, neither received a mixed-currency lab deduction, and each had a visible exception. The lab order, its single payable and member price snapshots were unchanged by those decisions. The initial test incorrectly assumed both tooth-specific clinical cases were one; the corrected test asserts the real two-case behavior. The failed initial run is not counted as a pass.
- Three historical suites passed 31 cases: populated follow-up-coverage full archive restore, retired writer and canonical command status. Historical command and receipt adapters in these tests are frozen test fixtures; current reads and retirement are product code. These tests check preserved records, registry timestamps, receipt/rejection and no unauthorized new writer.
- Focused commission and staff inventory units: 20 passed. Inventory regeneration changes only the source digest and retains NOT_READY and the original classifications.

The original 0079 SQL SHA-256 remains `5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99`; its embedded source SHA-256 remains `b4e70b75c3967b2e3dce85e4beecb912f75e2bdf8534713c38e7bde80576f9a9`. No migration or historical data was rewritten.

These focused tests do not certify full PostgreSQL, full browser/print, CI or a complete extraction. The prior browser/PDF proof belongs to the isolated commission branch, not this combined build. Historical restore remains subject to the raw-SQL CLI limitation described in the 0079 integration report. Daily adjustment steps were not changed. Typecheck status is reported in the delivery message.
