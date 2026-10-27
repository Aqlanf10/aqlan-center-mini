# Patient file numbering — registered locally, not published or deployed

Original proposal base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`.
Local sequential integration base: `18a09ab2c352bf47d9f0bcf804a8b50983f29eaf`.
Coordinator-approved migration **0080** is registered between 0078 and 0081/0082.
The later return-visit composition registers 0079 for explicit routine orthodontic coverage; numbering retains version 0080. Exact runtime SQL is verified against numbered migration bytes.

## Invariants

- Never change `patients.id`, clinical/financial foreign keys, invoice/receipt identity,
  or any existing file number during migration. No automatic renumber or backfill.
- New files use fixed `P-` and at least five digits. Default future floor: 7000
  (`P-07000`). Actual next number is the greatest of floor, live sequence next,
  largest current numeric alias + 1 and largest retired numeric alias + 1.
- Pure preview displays all four sources and actual next number; no sequence advance.
  Policy changes require expected version, expected next number and a reason.
  The floor only increases; preview does not reserve a number.
- Existing file edits are a separate admin-only command, never demographic PATCH.
  Require exact current number and version plus reason; transaction owns session
  revalidation, locks, patient change, retirement and audit. Audit failure rolls back
  all row changes. Sequence gaps from failed creates are allowed, not recycled.
- Old aliases cannot be assigned to any patient again. Retirements survive patient
  deletion/merge, are append-only, and prevent factory reset when nonempty.
- No policy seed row: virtual default7000/version1; first audited configuration
  inserts version2. This avoids a collision on empty-target official restore.
- READ COMMITTED is required for identifier mutation and allocation. RR/SERIALIZABLE
  writes fail explicitly, including stale snapshots after an advisory lock is free.
  Existing read-only backup/report snapshots remain supported.
- Legacy normalized duplicate aliases cause readiness refusal, not cleanup. Operator
  must review/correct ambiguities explicitly; no automatic rewrite is permitted.

## Locks and concurrency

Administrative edits/configuration: authenticated user SHARE → import exclusive →
numbering exclusive → exact patient row (for edits). Allocation: import shared →
numbering exclusive. Import already owns import exclusive and uses the same allocator.
Direct legacy patient-number writes acquire numbering with try-lock: fail fast rather
than reverse patient-row/advisory order and deadlock an administrative writer.

Indexed numeric projections and unique normalized alias-key indexes avoid relying on raw-text uniqueness
for aliases. Numerical equivalence (P-7000 / P-07000) and trimmed uppercase equivalence
are rejected. Maximum projections use expression indexes; production performance has
not been measured and is not claimed.

## Identity and historical references

Patient URLs and linked rows retain the same internal ID. Existing saved documents
are untouched. Existing live invoice/statement reprints resolve the current patient
number as before; original paper references are historical aliases retained by the
reservation and audit records, not new patient identities. No old-alias portal-login
fallback is added. Portal login uses the new current number; an already signed token
with the old alias is invalidated against its original patient ID. UI warns the operator
that the patient must be told the new login number. Full bigint alias length21 is
accepted by portal validation (previous ceiling20 was inconsistent).

## Restore/reset

Official SQL/full-archive serialization orders current patients before retired aliases,
without a retirement FK that could cascade. INSERT replay does not generate history.
The official dump includes patient_number_seq high-water/is_called restoration using
monotonic setval; a newer target value is never decreased. Populated official restore
and reset rejection require real PostgreSQL acceptance before registration/publication.
No live backup, production/staging data or sensitive credentials were read or changed.

## Authorization and UI integration

The current integrated application uses strict admin HTTP matrix, route, component,
and transaction-session revalidation. The editor is mounted in the patient identity
section, keyed to exact patient/session owner; demographics cannot edit file numbers.
No unfinished capability core has been activated. The later permissions task must
adapt this explicit seam to `patients.number.edit` (requires patients.view +
patients.edit and both exact-target scopes) and `patients.numbering.configure`
(requires settings.view). Current admin-only behavior remains deliberate until that
adapter is implemented and verified. No delegated roles are implicitly granted.

## Local acceptance

Original proposal evidence: 19 PostgreSQL18.6 tests, retained in the external evidence
folder. Registered integration adds migration-after-recorded0081/82 acceptance,
restart/checksum/unregistered-object refusal, populated official SQL/full-archive
restore and the actual stagedRestore path. The current run outcomes are recorded in
`LOCAL_ACCEPTANCE.md`; no CI, browser, staging or production outcome is implied.

Reset now refuses before backup/mutation if any current patient or retired alias
exists, preserves numbering policy, and never restarts patient_number_seq. This is
an intentional safety boundary, not a cleanup workaround. Do not delete patients to
make reset available. Empty patient-free reset remains supported.

## Mandatory predeployment readiness

Call `patientNumberingReadiness` on an established read-only operational connection
BEFORE any deployment or migration is started. It needs only the existing patients
schema and returns counts, not identifiers or patient records. `ready:false` is a hard
release blocker; retain the current working release. The SQL migration's duplicate
refusal is a second transactional defense, never a substitute for this predeployment
check. No production readiness result has been claimed or gathered by this child.

Owner resolution must be a separately reviewed, exact-record correction: establish
which paper identity belongs to each internal patient ID, explicitly select an unused
replacement, preserve all linked rows and document the old/new values, actor and reason
in immutable audit/history. Do not delete a record, erase prior history or run automatic
canonicalization. The blocked migration itself performs no resolution. Rerun the
read-only count check and independently verify the correction before permitting release.

## Bounded performance observation

With 1000 additional synthetic rows (1022 total), PostgreSQL selected a backward scan
on `patient_number_numeric_idx`, read one index result and hit three shared blocks;
measured execution0.249ms in this local run. This proves the maximum projection uses
its expression index here; it is not a production-size benchmark or throughput claim.

## Remaining release acceptance

- Independent root review of exact integrated head, migration and schema contract.
- Browser edit/duplicate/stale/retry/cancel/repeated-click/navigation and future-floor
  preview journeys; static render tests do not count as browser QA.
- Mandatory count-only operational predeployment readiness described above; use
  `db:preflight -- --patient-numbering-readiness` on an explicitly authorized target.
  Exit 2 means complete evidence with an alias-readiness blocker, not release approval.
  No live readiness result has been gathered or claimed.
- After all sequential local tasks: root-managed combined publication, full CI,
  Staging acceptance, approved promotion and Production verification.
- Later canonical capability adapter with exact resource scopes, without weakening
  present admin gates. No future AI/Dot functionality is included.
