# Review fixes after PR345 head8c47c271

Product checkpoint: `bb39664bcb873049840bd09ece0cfd85063f59ea`.
These changes are local and await parent diff review before push. No schema,
conversion amount, receipt/cash writer, snapshot cleanup or payroll fence changes.

## P1: historical commission capacity

The red PostgreSQL test creates an older2500YER invoice with900SAR historical
receipt, then an independent100SAR invoice and100SAR receipt for another doctor.
The January2020 report initially earns30SAR for that second doctor. Correcting
the older invoice today used its old policy timestamp as FIFO time: the future
SAR successor consumed the independent receipt before being excluded by inRange.
The red result changes earned/due/netEarned from3000 to0minor.

Fix: retain original created_at for policy resolution; add issued_at/issued_at_us
for allocation ordering. Exclude future currency-correction successors at the
report cutoff. Ordinary non-reclassified invoice FIFO behavior is unchanged.
The test compares the **entire report array**, not only one total, before/after
correction and asserts byte-equivalent receipt JSON.

## P2: correction with no historical receipts

A zero-event correction still has a validated append-only document. Previously,
reclassifiedTargets came only from receipt events; the first later SAR receipt
fell into ordinary FIFO and earned30SAR for an earlier independent invoice.
The separate red test proves that incorrect3000minor allocation.

Fix: derive targets from correction documents joined to their owned target
invoice and same-currency successor chain, effective by the report cutoff.
The existing evidence reader validates all documents, including zero-event ones,
before the target map is used. No extra read query or global FIFO rewrite is
introduced. The green case gives0 to the independent doctor and3000minor to the
corrected invoice's doctor, with unchanged receipt JSON.

## UI transition guard

Changing to SAR is refused with an Arabic explanation if a retained draft changes
quantity, removes a line, or changes service/doctor/site identity. The selected
currency remains YER and edits remain editable. No silent reset is performed.
The native browser test covers quantity change, deletion, preserved drafts,
restoring compatible values, SAR→YER→SAR, and the original lost-response flow at
390 and1280.

## Verification

- Red: both new PostgreSQL tests fail on published8c47c271.
- Green:26 feature/settlement PostgreSQL tests pass on the final patch.
- Commission/payroll regression:152 tests across9 files pass.
- Typecheck, targeted lint (0 errors,8 existing warnings), production build pass.
- Built HTTP:20 tests across5 files pass, including transition refusal/return
  and lost-response recovery at390/1280, plus commission detail/configuration.
- Full unit rerun:10053 passed,1 existing skip across565 files.
- Money guard and git diff whitespace checks pass.

Evidence: [red/green and regression logs](evidence/review-p1-p2/).
The original full-suite report remains checkpointed to the published head;
no broad PostgreSQL or broad HTTP pass is claimed for this review patch.
