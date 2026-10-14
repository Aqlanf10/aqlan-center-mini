# Monthly invoice follow-up acceptance checklist

Base: merged invoice release `9b1ddc0e7d0d2bcf5a5159089e3dc55be6da8216`.
Branch: `feat/invoice-monthly-schedule-20261014`.

| Requirement | Implementation | Verification / evidence |
|---|---|---|
| Explicit proposed downpayment, separate from receipt | `DebtRepaymentEditor` generator, existing `down_payment` terms | UI labels; PostgreSQL-backed browser asserts zero payments after normal/historical saves |
| 12 / 15 / 18 months and custom count | Generator presets and editable integer count | Browser exercises all presets and custom 2/3; pure tests 1/12/15/18/59, invalid counts and maximum 60 total rows |
| First monthly due date, calendar-safe month ends | `monthlyDueDate`, anchored original day and Gregorian leap rule | Jan31 → Feb28 → Mar31; leap2028; century2000/2100; year rollover; invalid/overflow dates |
| Exact minor-unit remainder distribution | BigInt quotient/remainder; earlier months get at most one extra minor unit | SAR 101000 / 3 = 33667,33667,33666; YER 1010 / 3 = 337,337,336; maximum safe integer sum |
| Editable generated schedule | Existing date/amount rows remain canonical | Browser edits amount, observes save refusal, regenerates; existing manual schedule collection/revision/cancellation suites |
| Discount / amount change regeneration | Generated basis warning and existing canonical exact-sum validation | Browser 1500 → 1400 after reasoned allowed discount, then proposed490 +303.34+303.33+303.33 |
| Historical remaining debt only | Existing caller passes net minus paid-before exactly once | Browser original1500 / paid-before500 → opening1000; proposed490 +255+255; no invoice or receipt |
| Zero remainder / invalid count | No zero-valued installment; full payment produces proposed-row-only; zero debt produces full/empty | Pure tests; positive residual count1..60 minus optional downpayment; tiny remainder refuses |
| Recovery, duplicate guards, current permissions | Controlled draft metadata only; serializes actual validated rows; fieldset and handlers honor disabled; no API/security changes | New normal save double-click plus existing ordinary/historical lost/malformed/reload recovery browser suites and role refusals |
| Receptionist price access | Existing `/api/services`, preview/save and native selector unchanged | Actual receptionist browser and HTTP, native/converted distinction, native override refusals; separate pricing audit JSON |
| Reason/discount authority | Existing native price and invoice discount checks unchanged | Existing reason/limit HTTP matrix; unpriced missing-reason gap explicitly reported in converted-quote proposal |
| Native priority and converted quote policy | **Proposal only**, no pricing implementation | `INVOICE_CONVERTED_QUOTE_PROPOSAL_20261014.md`; synthetic rates are not live inferred rates |
| Premium screen/global design preserved | Only shared repayment editor and pure helper changed in product source | Actual390/1280 screenshots; no global/sidebar/reception screen, schema, CI or pricing changes |

Commands, counts, hashes, remaining issues and exact pushed commit are recorded in the companion handoff and external verification receipts. Screenshots show implemented pages from the built app with synthetic records; no generated mockups or live patient data.
