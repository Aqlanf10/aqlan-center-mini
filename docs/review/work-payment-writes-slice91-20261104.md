# M2 slice 91 — payment correction and debt repayment on the canonical runtime (2026-11-04)

Group 4, after slice 88. The design is in [financial-group4-contract-design-20261104.md](financial-group4-contract-design-20261104.md). This slice follows the owner's money rule (6615124926) and the unchanged business rules.

## Routes and rules

| Route | Canonical rule | Legacy rule |
|---|---|---|
| `POST /api/payments/[id]/correct`, `mode: "void"` | `finance.payments.void` | admin label |
| `POST /api/payments/[id]/correct`, `mode: "correct"` (a replacement receipt) | `finance.payments.void` + `finance.payments.collect` (map branch) | admin label |
| `POST /api/patients/[id]/debt-repayments` (arrange, revise, cancel) | `finance.payments.collect` inside the patient scope | admin or reception label |
| `POST /api/patients/[id]/debt-repayments/[arrangementId]/collect` | `finance.payments.collect` inside the patient scope | admin or reception label |

- Two runtime actions are added: `finance.payments.void` and `finance.payments.collect`. They are existing catalogue capabilities; no new grant is created.
- A patient outside the scope reads like a missing one (404), and nothing is written.

## How each write runs

There is one admitted operation per write (`withStaffOperation`, READ COMMITTED). The legacy writer body runs unchanged on the operation's transaction, after the staff authority locks:

| Writer | Extracted body | Legacy wrapper |
|---|---|---|
| Correction | `correctPaymentOn(client, input, ack, own)` | `correctPayment` owns the transaction (`own = true`) |
| Arrangement | `saveDebtRepaymentOn(client, input)` | `saveDebtRepayment` owns the transaction |
| Collection | `collectDebtInstallmentOn(client, input, options, own)` | `collectDebtInstallment` owns the transaction |

- **Transaction control:** inside the canonical operation, the body's BEGIN/COMMIT/ROLLBACK are no-ops. Any refusal outcome is raised, so the whole operation rolls back.
- **Kept unchanged:**
  - lock order;
  - request keys and replay rules (the key is bound to the actor's username, as before);
  - the open-shift rule (`no_shift` / "no open shift");
  - exchange-rate and remaining-debt guards;
  - the similar-collection review;
  - the audit row in the same transaction.
- **The correction's replacement rate** is chosen exactly as before: the saved-key rate for the same actor, else the configured rate. One helper serves both runtimes.

## The debt actor

The legacy debt writers revalidate the legacy session (admin or reception label) at each step. A canonical caller passes `canonicalDebtActor(identity, recheck)` instead:
- it is branded by a module-private symbol, so a JSON body or an object built elsewhere never passes (tested);
- `recheck` re-asserts the live operation and `finance.payments.collect` on the **same transaction client**, wherever legacy revalidated;
- a branded actor whose recheck fails is refused with `unauthorized` (tested).

## Tests

| Gate | Result |
|---|---|
| PG `payment-writes-canonical` | 6/6 |
| Legacy PG touching the extracted writers (correction, debt arrangement and collection, acknowledgment evidence, shift admission, runtime action list) | 54 files, 1033/1033 (two manual-cash proofs each on a fresh disposable database, as CI runs them) |
| Related unit (routes, writers, runtime actions) | 14 files, 241/241 |
| Readiness and map audits | 10/10 (the runtime action list pinned) |
| Typecheck, lint on the changed files | clean |

What the 6 PG tests cover:
- void, with its audit row carrying the canonical actor and the reason, and exact replay;
- a replacement receipt refused without the collect grant, with nothing written, then done with it;
- refused without the void grant (collect and ledger grants never substitute);
- no open shift rolls the whole operation back (no receipt, no audit);
- revocation;
- arrangement and collection inside the scope (`created_by` and audit carry the canonical actor), with replay;
- outside the scope reads like missing, while the doctor's own patient succeeds;
- no grant, no shift and revocation refused, with nothing written;
- forged and stale debt actors refused.
