# Commission and laboratory decisions of 2026-11-11: what is implemented, what waits

Branch `feat/claude-work-continuation-20261110`. Synthetic data only. Nothing is merged or deployed.

## 1. Percentage after the invoice discount — implemented

- The invoice discount (line total minus invoice net, in the invoice currency) is spread over all of the invoice's lines in proportion, in whole minor units: floor parts first, leftover units to the largest remainders. The parts add up to the discount exactly; no line is discounted beyond its amount. `allocateInvoiceDiscount` in `lib/commission.ts`.
- Each doctor's base is his line after its part of the discount. Laboratory and material costs are then deducted by the doctor's policy, then the percentage is applied. A line without a doctor carries its own part of the discount.
- Failure-first witness: the existing test that characterized the old basis (10,000 with a 2,000 discount at 30%: 3,000 accrued) now expects 2,400.

## 2. Late collections belong to the payroll month of collection — implemented

- A run pays the doctor's **cumulative commission due at the period end**, per currency: everything earned on collections up to that day, on any invoice, minus every commission voucher paid, minus what other runs have committed. For a run that ends by this period's end only its **unpaid remainder** is subtracted (its paid part is already inside "paid"), so nothing is subtracted twice.
- Calculation, approval and disbursement all use the same figure. Approval and disbursement take the doctor's party row lock first and re-check under it, so two periods for the same doctor and currency cannot both commit the same money.
- An approved or closed run is never rewritten. A refund afterwards lowers the cumulative due; the next run absorbs it. A negative balance stays on the doctor's statement and is covered only by later commission; it is never taken from the base salary.
- Each payroll item records the source of its commission: the cumulative earned and paid, what was committed elsewhere, how much comes from the period's own invoices and how much from later collections and adjustments. The pay-terms snapshot on the item keeps the contract, its version and kind.
- **Not done:** a settlement ledger with one row per collection and invoice. It needs a new table, hence a migration number; numbers 0090–0125 are in use by other lines. The duplicate protection above does not depend on it.

## 3. Doctors sharing a case — rule implemented in the engine; storage waits for coordination

**Owner decision (2026-11-11):** option 2, decided per case. The centre approves each participant's share of the work for the case; the shares add up to 100%; each participant is paid at **his own contract rate on his part** of each line's base after the discount, with laboratory and material costs split by the same shares and deducted by each participant's own policy. Equal shares are allowed when the centre approves them. Session counts may guide the decision but never set it automatically. Without an approved split the shared commission is **held** and paid to no one.

Worked example: line base 100,000; A at 40% with 60% of the work, B at 30% with 40%: A 24,000, B 12,000, clinic 36,000. The result does not depend on which doctor is recorded on the line.

**What existed.** Every invoice line has exactly one performing doctor (`invoice_items.doctor_id`), so separate lines of two doctors never overlap and nothing was paid twice. `commission_case_overrides` sets a doctor's *rate* for a case; it does not split a line. The model could not express a shared line.

**Implemented now (pure engine, `lib/commission.ts`, 14 tests):**
- `caseParticipationProblem`: an approved split must have at least one participant, no duplicate doctor, whole basis points, and a sum of exactly 10,000; it names what is wrong otherwise.
- `allocateByWeights` and `splitShareByParticipation`: the line's amount and each cost are split in whole minor units by the shares; the parts add up exactly.
- `commissionForPatientAtEventTime` takes `participationAt` and `onHeld`: a line of a case with an approved split becomes one share per participant; a pending or incomplete split holds the line and reports it; a case that is not shared is untouched.
- Tests cover: one doctor, two doctors with different and equal shares, shares below and above 100%, no split, the discount first, laboratory and material costs, part and late collection, refund, currencies, rounding, and recalculation giving the same result.

**Not implemented: storing and approving the split.** It needs a new table (the split, its participants, who approved it, when, the source and reason, append-only with a superseding chain like `commission_case_overrides`), a grant, an audit row in the same transaction, and wiring into `commissionReport`. Registering a table on this branch means updating the strict schema expectations, one of which is `__tests__/security-http/hr-temporal-history-ui.test.ts` — a file Dot's #532 is changing. That is a shared file, so it is not touched here; the storage step waits until #532 lands or Dot agrees the one-line registry addition. The migration number also has to be agreed (0090–0125 are in use by other lines).

**How a later change will behave (by construction of section 2).** A split approved or changed after a run was approved never rewrites that run: the participants' cumulative commission changes, and the next run pays the difference to the one who gains and carries a negative balance for the one who was overpaid. The split record itself (author, time, reason, superseded record) is the documented adjustment.

## 4. Cancelling a laboratory order — implemented

- The order reads "paid" only when its payable is fully settled (net of voided vouchers).
- A debt is never dropped merely because no voucher exists. Only an order that was never sent to the laboratory (status "needed") takes its payable with it, because no work was commissioned. Once sent, the payable and any unpaid remainder stay visible and owed.
- The payable row is locked before its vouchers are counted, so a payment in flight is counted and never left linked to a deleted payable.
- **Not done:** the documented waiver or settlement act for the remainder of a cancelled order (a negative adjustment with a reason, an approver and an audit row). It waits for the settlement policy with the laboratories.
