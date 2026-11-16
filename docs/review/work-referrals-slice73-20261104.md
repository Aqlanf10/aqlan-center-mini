# M2 slice 73 — referrals on the canonical runtime (group 3, 2026-11-04)

Second contract of group 3 in the [remaining plan](work-remaining-plan-20261101.md). Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (4 methods) and authority

| Method and route | Canonical | Legacy |
|---|---|---|
| `POST /api/patients/[id]/referrals` (external letter or internal referral) | `clinical.referrals.manage`; the issuer is the actor's validated clinician link; patient in scope; `requestKey` | doctor, or admin linked to a doctor party; reception refused |
| `PATCH /api/referrals/[id]` (close an external referral) | `clinical.referrals.manage`, patient in scope | any role with patient access |
| `POST /api/referrals/[id]/transition` | `clinical.referrals.manage`; see the table below | `canActOnReferral` by role label |
| `GET /api/referrals/mine` | `clinical.referrals.manage`; clinician link; patient scope; appointment scope for today | doctor or admin labels |

Workflow steps (translation of `canActOnReferral`; nothing is widened):

| Step | Who may take it |
|---|---|
| accept, decline, complete | the receiving clinician |
| cancel, acknowledge | the referring clinician |
| schedule | the receiving clinician, or an actor with the whole appointment scope (the accepted slice-23 translation of «reception») |
| any step | the protected owner (the legacy «admin» label is not carried over to other accounts) |

## Behaviour

- **Scope:** a referral or patient outside the actor's patient scope answers like a missing one (404) before the workflow writer runs. Its kind and state are never disclosed.
- **Writers:**
  - internal create: the legacy body, extracted unchanged;
  - workflow step: `transitionInternalReferralOnClient` unchanged (appointments locked before the referral row), with the scope and side checks inside its `authorize` hook;
  - external letter and its close: same SQL as legacy, with the audit row now in the same transaction. The legacy writers are untouched.
- **Duplicate prevention:** create needs a `requestKey`. Under an advisory lock on (actor, key), the receipt (the same-transaction `referral.create` audit row) is checked first:
  - a double press or a retry returns the first referral (`replayed`);
  - a reused key with another body is refused (409).
- **Concurrency:** two concurrent accepts — one wins, the other gets `referral_invalid_transition` (409); exactly one audit row.
- **Screens:**
  - The canonical patient file shows each referral's valid steps (from the state machine), the external close, and an issue form. Receivers come from the canonical «mine» read: active doctors, names only.
  - `/my-work` («عملي السريري») is registered as a canonical page (`clinical.referrals.manage`, patient scope). Both of its API calls are canonical.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `referrals-canonical` (new) | 8/8 |
| Legacy PG `referrals`, `internal-referrals`, `referral-arrival`, `referral-reschedule-consistency` | 48/48 |
| Journey `canonical-referrals-journey` (portOffset 122) | with the batch gates |

## Limits

- The referral letter print page (`/print/referral/[id]`) stays legacy. It holds no money; it moves with the print/export work.
- No grant is given to any account.
