# M2 slice 87 — the visit's lab work on the canonical runtime (2026-11-04)

Closes the two refusals left open in slices 85–86: a lab draft inside the visit save, and signing a visit that carries durable lab work.

## The actor binding

- **The problem.** The lab identity layer (`lib/lab-work-intent-db.ts`) re-validated a legacy session (role labels doctor/admin) before every receipt, identity and order write.
- **The new actor.** A canonical caller passes `canonicalLabActor(identity)`:
  - a value branded by a module-private symbol, so a JSON body or any object built elsewhere can never pass as one (tested);
  - it carries the user id the receipt is keyed on, plus the username and role display that order tracking already recorded.
- **When it is used.** The lab layer accepts it in place of re-validation **only because** the canonical operation has already proved, in the same transaction:
  - the patient scope;
  - the clinician link or the owner;
  - `clinical.lab.order`.
- **Legacy sessions** are unchanged (lab PG 100/100, related unit 160/160).

## Lab draft inside `POST /api/visits/[id]/clinical` (save)

- **Who:** a clinician-linked actor or the owner holding `clinical.lab.order` (legacy doctor/admin). These checks come before body validation.
- **Command identity:** the legacy one — request key, the body's sha256, and the expected patient.
- **Replay:** an exact replay returns the saved result and writes nothing new.
- **Rejection:**
  - A deterministic rejection (the legacy route's set) rolls back the save.
  - It is then **settled durably** in a freshly admitted operation that re-proves the same authority, for the same actor.
  - Unknown failures stay unresolved, as in legacy.
- **Response:**
  - success: `labWorkCommand` (key, hash, visit, patient, actor);
  - rejection: `labWorkOutcome: "rejected"` with the code (409).
  - The canonical receipt read (`GET lab-work-command`, slice 84) finds it.

## Signing a visit with lab work

- **Who:** only a clinician-linked signer or the owner holding `clinical.lab.order`. Without it: 403, and nothing is signed.
- **The review fence:**
  - The legacy fence `labSignVersion` hashes the procedures' prices, so it stays in the money group (slice 84).
  - New: **`labReviewVersion`**, the same clinical and lab identity with no price and no currency. It is part of the cockpit's clinical group.
  - The canonical sign compares it under the visit's locks (stale → 409), then supplies the full fence itself. The legacy body re-checks that fence under its own locks.
  - A reviewer without the money view therefore signs against exactly what they saw, and never sees a price.
- **The order** materializes with its tracking row bound to the canonical actor.

## Tests

| Gate | Result |
|---|---|
| PG `visit-lab-draft-canonical` | 5/5 (save + receipt + identity bound to the actor; replay; authority before validation; durable rejection; sign with the money-free fence, stale fence, no lab grant; a forged actor refused) |
| PG visit suites (read, save, sign) | 8, 6, 9 — the owner-equality test now asserts the one added clinical field separately |
| Legacy lab PG (lifecycle, invoice integration, registration) | 100/100 |
| Related unit | 160/160 |
