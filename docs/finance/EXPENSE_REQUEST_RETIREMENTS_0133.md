# Expense request retirements (migration 0133)

Status: specification written before tests and code (2026-11-14).
Sources: review on #483, comment 6883224187 (a refusal that finds nothing under a request key proves the
key empty only at that moment); number allocated in 6883984936 (conditional, re-check before pushing and
integrating). Builds on `docs/finance/EXPENSE_COMMANDS_0128.md` §2.1; 0128 itself is published and is not
changed.

## 1. Problem

An expense request key (0128) makes a retry of the same request return the first voucher. A refusal
decided after the key check says `requestKeyState: "unused"`: under the key's lock, nothing was recorded
under the key. That is true only while that transaction runs. An earlier send of the same key that is
still on its way can reach the server afterwards and write the voucher. A screen that treated "unused" as
final would let the user enter the expense again under a new key, which gives two vouchers. The interim
client rule (`c04db046`: a refusal settles an attempt only when it answers the attempt's only send) closes
the common case. It cannot prove anything after a reload, a lost answer or a second send.

## 2. Rule

A key becomes **retired** for one request when the server commits a retirement row for it. From then on,
no expense can be written under that key **for that request**.

- **Same lock.** Both the retirement and every expense insert carrying a key take the per-key transaction
  lock already used by 0128 (`aqlan.expense.request:<key>`). The check and the write cannot interleave.
- **Bound to the request.** A retirement row stores:
  - the key;
  - the request fingerprint (the 0128 `idempotency_request_hash`, which already covers the actor);
  - the actor's username;
  - the time.

  The insert fence refuses an expense whose key, fingerprint and actor all match a retirement. A request
  with another fingerprint or another actor is not that request: a different or unauthorized request
  cannot retire, and so cannot cancel, a legitimate one.
- **Saved first wins.** If an expense already carries the key, retirement writes nothing.
  - Same fingerprint: the answer is that voucher (the receipt is returned; nothing is cancelled).
  - Another fingerprint: 409 conflict.
- **Retired first wins.** A late request whose key, fingerprint and actor match a retirement writes
  nothing: no voucher, no drawer movement, no payable settlement, no audit row of a create. It is refused
  with 409 `expense_request_retired` and its Arabic message, with `requestKeyState: "retired"`.
- **Permanent.** Retirement rows are append-only: no update and no delete. TRUNCATE is allowed only on an
  empty table (as in 0068). The clinic reset leaves them in place: they hold no money and no patient data,
  and a kept retirement can only refuse a key that no longer exists.
- **Survives the refusal's rollback.** A refusal rolls its whole transaction back. The retirement runs in
  its **own** transaction after that rollback, under the key lock. The server reports
  `requestKeyState: "retired"` only after that transaction **committed**. If it did not commit (error,
  lost connection), the answer carries no key state, and the screen keeps the attempt unknown.

### 2.1 When the server retires

1. **Automatically, after a refusal decided after the key check**, on both expense routes (legacy and
   canonical). Examples: the drawer limit, a stale quote, a missing supplier or payable, an invalid
   split, the owner-only private part, an unset funding account. The refusal's own transaction is rolled
   back first; then the key is retired for that request's fingerprint and actor in a new transaction.
   - A key conflict (`expense_request_conflict`) is never retired: the key already holds a voucher.
   - A request refused before the key check (session, permission, body shape) is never retired: it has
     no proven actor or fingerprint.
2. **On request, by the user who sent it:** `POST /api/expenses/attempts/retire` with
   `{ key, body }`.
   - `body` is the exact request body the screen sent. The server recomputes the fingerprint from that
     body and the current session's actor, using the same parser and hash as the create.
   - If the body no longer parses (settings changed, values invalid), the server cannot bind the
     retirement and refuses with 409 `expense_retirement_unproven`. The screen keeps the attempt unknown.
   - The answers:
     - `retired`;
     - the saved voucher (same fingerprint);
     - 409 conflict (another fingerprint or actor holds the key);
     - 401/403 (expired or unauthorized: nothing is written).
   - This is how an attempt whose sends never got any answer is closed for good. It replaces "hide after
     checking by hand" as the normal way out; hiding stays available.

### 2.2 What the screen does

- `requestKeyState: "retired"` is final. The attempt is settled as refused, whatever its send count.
- `"unused"` is still sent for a refusal decided before the request could be bound: invalid values, or a
  private part on a legacy session. There is no fingerprint to retire there. The screen accepts `"unused"`
  only for an attempt's only send (the interim rule of `c04db046`); after any earlier send the attempt
  stays unknown until «تحقّق» or «أنهِ هذا الطلب نهائيًا» settles it.
- An unknown attempt shows «أنهِ هذا الطلب نهائيًا» next to «تحقّق». It calls the retire route with
  the attempt's exact body and key, and settles only on `retired` or on the saved voucher.
- The user is never handed a new key for the same entry while the old attempt is unknown.

## 3. Storage (migration 0133)

`expense_request_retirements`:
- `idempotency_key` TEXT PRIMARY KEY, using the shared key pattern;
- `request_hash` TEXT NOT NULL (64 hex characters);
- `retired_by` TEXT NOT NULL (trimmed, 1–200 characters);
- `retired_at` TIMESTAMPTZ NOT NULL DEFAULT now().

One retirement per key. A second retirement of the same key for the same fingerprint and actor is an
idempotent success in the application. For anything else it is a conflict.

Triggers:
- `expense_request_retirement_guard`: refuses UPDATE and DELETE; TRUNCATE only of an empty table.
- `expense_request_retirement_fence` (BEFORE INSERT on `expense_request_retirements`): takes the key lock
  and refuses if an expense already carries the key.
- `expense_request_key_fence` (BEFORE INSERT on `expenses`, WHEN `idempotency_key IS NOT NULL`): takes the
  key lock and refuses if a retirement matches the key, the fingerprint and `created_by`.

The application checks the same rules first and answers with Arabic messages; the triggers are the last
line.

**Why not copy 0068 as is.** 0068 binds a retirement to the patient and the operation. Expenses have no
patient. The fingerprint already covers the actor, the category, the party, the amounts and the payment
source, so it is the binding. 0068 fences any receipt under a retired key. Here the fence matches the
fingerprint and the actor too, so that a retirement can never cancel another person's or another
request's voucher.

Runtime registration: constant `lib/expense-request-retirements-schema.ts`, byte-identical to the SQL,
registered after 0132.

## 4. Tests (failure first, synthetic data, real barriers, no sleeps)

PostgreSQL, on both the legacy writer and the canonical command:

1. **Late first request after a retirement.** The first request is held by a real lock barrier before
   it reaches the writer; the retirement commits; the first is released. Result: refused
   `expense_request_retired`, with zero vouchers, drawer movements, payable settlements and create audits.
2. **Save first.** Retiring a key that holds a voucher writes nothing and returns that voucher; the
   voucher is not cancelled or duplicated. With another fingerprint, the answer is a conflict.
3. **Mismatch.** A retirement by another actor, or for another fingerprint, does not block the original
   request, which then writes its single voucher.
4. **Authority and session.** Retirement by an expired session or without the expense grant (canonical),
   or without the legacy permission, writes nothing.
5. **Concurrency.** Save and retirement race under the key lock: exactly one wins, and the loser's answer
   names the winner's outcome.
6. **Rollback survival.** The refusal's transaction is rolled back and the retirement row still exists
   afterwards. If the retirement transaction fails, the answer has no `requestKeyState` and nothing is
   claimed.
7. **Database fence.** A raw INSERT of a matching expense under a retired key is refused by the trigger.
   UPDATE and DELETE of a retirement are refused. TRUNCATE of a non-empty table is refused.

Unit tests: the screen settles only on `retired` or on a receipt, and the retire button is wired to the
exact body and key. Browser, on both screens (the petty expense and the supplier bill):
- the first send is dropped before the server; the retry is refused and retired;
- the late first request writes nothing;
- no new key is minted before the old attempt is settled;
- vouchers, drawer movements, settlements and audits are counted.

## 6. Implementation notes (2026-11-14)

- Legacy: `recordExpense` retires after its own rollback (`retireRefusedExpenseRequest`), so the legacy
  route and every internal caller with a request key get it. The legacy fingerprint is one function,
  `lib/legacy-expense-fingerprint.ts`, shared by the create route and the retire route.
- Canonical: the command computes the fingerprint once (`fingerprint()`, shared with
  `commandCanonicalRetireExpenseRequest`). It retires after the operation's rollback. If that retirement did
  not commit, it reports neither "retired" nor "unused".
- Reset: `expense_request_retirements` is in the reset keep list. Unlike 0068, it never blocks a reset,
  because every refusal now leaves a row.
- Red before green:
  - PostgreSQL: a probe of the late-first-request scenario on the pre-0133 source wrote a voucher on both
    paths (expense ids 1 and 2). The full suite was red 9/9, then green 9/9.
  - Unit: three cases were red on the pre-`c04db046` client.

## 5. Limitations

- Retirement makes "not recorded" final for one request fingerprint. A late request with a different
  fingerprint under the same key is a different request and follows the 0128 rules (it is refused as a
  key conflict if the key already holds a voucher; otherwise it writes its own voucher).
- Payroll disbursement and the lab batch settlement do not use expense request keys and are not covered.
