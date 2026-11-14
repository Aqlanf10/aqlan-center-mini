# M2 slice 88b — the case's responsible doctor, owner only (2026-11-05)

Owner decision G4-7 (6648682456): changing the doctor responsible for a case belongs to **the protected owner alone**, for now. No finance grant and no general administrative label can do it.

## Rule

- **Owner-only operation:** `GET/PATCH /api/patients/[id]/responsibility` needs the new owner-only operation `clinical.case-responsibility.change`. Owner-only operations are never editable grants: they cannot appear in a permission document, so no account can be granted this.
- **Map entry:** the route's `need` changes from `finance.patient-ledger.manage` to this operation.
- **Admission:** the request rides on `patients.edit`, an action the owner always holds. An account that holds `patients.edit` but is not the owner is refused (tested). So are a "manager" account with the admin label plus the ledger-manage and plan-edit grants, and a doctor with ortho-edit.
- **Re-checks:** the operation is proved wherever the legacy writer revalidated its admin session: before the read, after the writes, and before the commit.
- **Later delegation:** needs its own decision and a narrow, independent clinical grant.

## The body, unchanged

`patientResponsibilityOn` is extracted from the legacy writer:
- the source fingerprint guards against a stale view (409);
- the chosen doctor is held `FOR SHARE NOWAIT`;
- the case rows are locked `FOR UPDATE NOWAIT`: contention is a bounded 409, never a wait;
- a written reason of 3–500 characters is required;
- the `case.responsibility_change` audit row is written in the same transaction, carrying the actor, the previous rows, **the previous doctor** (`previousDoctorId`, added for both runtimes) and the new doctor.

## Tests

| Gate | Result |
|---|---|
| PG `case-responsibility-canonical` | 4/4 |
| Legacy PG touching the writer and owner operations (incl. the restore round trip) | 4 files, 105/105 |
| Related unit | 9 files, 231/231 |

The 4 PG tests cover:
- the owner reads and changes, with the full audit;
- no finance grant, admin label, `patients.edit` or clinical grant reaches it, and nothing changes;
- the reason, a fresh fingerprint and an active doctor are required;
- a concurrent holder of the case row is refused, not waited on.

The owner-only pin test now lists the new operation, citing G4-7.
