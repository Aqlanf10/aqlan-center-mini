# Plan reminder authorization and atomicity

The single/bulk POST `/api/plans/reminders` executes one actor-bound database command. It preserves the existing response fields and the effective admin/reception/doctor role boundary. A doctor needs current `canEditPlans`, a current active doctor-party link, and actual ownership of every target patient. `canViewAllPatients` does not extend write scope. No money-read capability is required.

## Request and permission validation

- Exactly one numeric positive PostgreSQL-integer `planId` or nonempty `planIds` array is required. A specified installment is a positive PostgreSQL integer and is allowed only for a single plan. Invalid IDs are rejected, never silently filtered; invalid installments never fall back to all-due selection
- A request accepts at most 300 entries, matching the existing active-plan list limit. Larger requests receive400 instead of truncation. Bulk IDs are deduplicated and sorted; committed count/audit count use unique plans
- HTTP and database-command validation share the same pure parser
- The session contributes only user ID, username, role, and credential version. The command reloads and locks the user row, verifies active identity/role/credential, and takes permission storage and party linkage from that row
- Legacy NULL, empty storage, JSON-null and ordinary legacy objects retain their existing `parseDoctorPermissions` defaults. Malformed envelopes and present nonboolean `canEditPlans` fail closed locally for doctors. Future canonical staff-capability envelopes remain inert and cannot activate new doctor grants
- Admin/reception derive authority from their current locked role and do not consult unrelated permission JSON, require doctor-party linkage, or require a plan-edit grant. This preserves current role semantics even for legacy, malformed or future permission storage; it neither interprets future grants nor implements granular admin restrictions. A broader staff-capability rollout is separate work

## Canonical ownership

A single static six-source definition is shared by the existing `doctorOwnsPatient`, `doctorOwnedPatientIds`, and the new transactional witness reader:

1. An active treatment plan with this primary doctor
2. A visit with this doctor
3. A planned visit with this doctor
4. The patient's primary doctor
5. An appointment with this doctor
6. An internal referral to this doctor whose workflow state is neither declined nor cancelled

This is patient-level ownership. The reminded plan need not itself name the doctor, and a completed internal referral still has the same ownership meaning as before. No other writer, schema, global default, or financial calculation changes.

## Locking and accepted concurrency contract

All explicit row-lock acquisitions use NOWAIT. Contention deliberately yields a retryable409 after transaction rollback, without automatic retry. This trades availability during concurrent edits for a bounded, fail-closed command without requiring a cross-domain lock-order rewrite.

The order is:

1. Current user `FOR SHARE`; current doctor party `FOR SHARE` for doctors only
2. Discover every target plan's patient without taking child locks
3. Lock all discovered patients by increasing ID `FOR KEY SHARE`
4. Lock all target plans by increasing ID `FOR UPDATE`; recheck every patient mapping against the discovery snapshot. A disappeared parent/plan or moved mapping causes rollback/409 rather than following a newly discovered parent out of order
5. For each patient in increasing ID order, select one affirmative ownership witness using the canonical source order above and increasing row ID, with `LIMIT 1 FOR SHARE`. A locked base row must still satisfy its actual predicate. This prevents non-key doctor/status/referral-state changes and deletion through commit. `KEY SHARE` alone would not protect those predicates
6. Lock the complete selected installment set in `(plan_id, number, id)` order `FOR UPDATE`; validate the explicitly requested installment exists
7. Only now generate one timestamp, stamp the locked plans/installment IDs, and insert one throwing audit row per unique plan on the same connection

Patient-first ordering follows merge/delete. Existing visit→plan and appointment→referral workflows can have different child orders, and ownership may come from an additional plan outside the target set. NOWAIT means these potentially inverted acquisitions never wait: a conflict rolls back the whole reminder batch. Ordinary non-key patient edits can coexist with the parent existence lock; when primary-doctor ownership is used, the additional patient `FOR SHARE` protects that ownership predicate.

If revocation commits before authorization, the new state is read and denied. If another transaction holds the relevant row, reminder acquisition fails409. If reminder authorization obtains its affirmative witness first, the conflicting revocation waits until the reminder commits or rolls back. All authority/witness/target locks remain held through audit and commit. There is no claim that a revocation requested later must take effect before an already-authorized transaction commits.

The no-number selection remains `due_date <= CURRENT_DATE`, including the prior eligibility of plans/installments. It is evaluated while acquiring installment locks, then updated by those locked IDs rather than rescanning for newly eligible rows after the first write. The command does not introduce paid-installment/status/clinic-day filtering. Parent-plan locks also block FK checks for concurrent insertion or reparenting into that plan. Selected installment row locks protect those rows against deletion, reparenting and due-date edits; unrelated unselected installment rows are not claimed to be locked.

A failed installment or audit write throws and rolls back everything. Known row-lock contention (`55P03`), PostgreSQL deadlock abortion (`40P01`), and a changed discovered mapping become409 only outside the awaited transaction helper. Other database/audit/uncertain-commit errors remain500, with no success response or retry.

## Verification boundaries

- `__tests__/plan-reminders.test.ts`: strict input and locally fail-closed legacy authority
- `__tests__/plan-reminders-route.test.ts`: real POST with mocked session/database boundary, exactly one command and no detached audit
- `__tests__/postgres/plan-reminder-authorization.test.ts`: guarded disposable real PostgreSQL18, all six ownership sources/read parity, account freshness, batch/missing-installment rollback, shared timestamp/audit count, forced later-write failure, two-connection witness/authority races, mapping movement and overlapping batch conflicts
- `__tests__/security-http/plan-reminder-authorization-http.test.ts`: built app with real sessions/effective role gates, raw no-write snapshots, owned/foreign/mixed requests, revocation, malformed authority and real contention

The presence of test source is not an execution pass. Run these gates only through the repository's guarded disposable-target workflow, under the coordinated runtime owner's control. Production is outside this local change.
