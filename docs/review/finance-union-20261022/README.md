# Finance union candidate — `integration/finance-candidate-20261022`

An isolated composition for review. It requests no merge to `main`, no deployment, no Railway access, and uses synthetic data only.

## Base and order (exact parents)
| Commit | Parents | Content |
|---|---|---|
| — | — | Base: frozen #422 `f8df350f` (unchanged) |
| `62a23c5d` | `f8df350f` + `f5d5f9d4` | #425 ortho approved-agreement funding. Clean |
| `729884ea` | `62a23c5d` + `6be14e34` | #423 six-direction unpaid currency and 0069. Migration-chain registrations conflicted (both sides extended the same lists). Resolution reused **byte-identical** from reviewed candidate `214212b9`: union 0066 → 0067 → 0068 → 0069 |
| `20758614`, `73aa9719` | — | `cherry-pick -x` of `5bf3c525` and `41dfd604`: 63-file chain counts; appointment-history chain includes 0069 |
| `fb9dbd94` | + `4f64425a` | #424 visit financial sources. Clean |
| `08941a7d` | + `591c4d0e` | #426 legacy balance guard. Clean |
| `854e6180` | + `dd51b593` | #427 portal statement parity. Clean |
| `55ff7b37`, `198775f3` | — | `cherry-pick -x` of #428's consent commits `3e5018d9` and `08dd1abe` only. #428's Vitest commit is not reapplied: `package.json` and `package-lock.json` are identical to `f8df350f` |

The schema contract and preflight disclosure were regenerated with the repository generators on PG18. Both are identical to the committed files: #424, #426, #427 and #428 add no schema change. #422's bounded bigint bootstrap guards (`a58e7fbd`) are untouched.

## Cross-slice acceptance (`__tests__/postgres/finance-union-source-acceptance.test.ts`)
1. **#425 + #424.**
   - Setup: an approved full-principal agreement funds an ortho case, so the adjustment is classified `INCLUDED` and signing bills nothing.
   - Result: #424's projection still reports that adjustment as **unresolved** (`adjustment_source_unresolved`), not covered, with no current reference.
   - An approved-agreement plan item stays `approved_source_unverified`; that case is already covered in `visit-financial-context.test.ts`.
2. **#423 + #424.**
   - **Read side:** `readInvoiceRevision` offers no cross-currency correction for an invoice whose line has a visit-procedure source (`INDEPENDENT_ITEM_SOURCE`, Arabic message). This shows readiness refusal only.
   - **Writer:** `reviseInvoice` for an unpaid SAR → USD correction of that visit-bound invoice is rejected with `conflict` / `INDEPENDENT_ITEM_SOURCE`. Invoices, items, payments, corrections, reclassifications and repayment arrangements are byte-identical before and after. The visit keeps its single exact current source.
   - **Projection:** the correction-lineage query only follows same-currency corrections, so no cross-currency lineage could be inferred.
   - **Control:** an exact same-currency source is verified, which shows the test can see coverage.
3. **#422 restrictions.**
   - `lib/http-permissions.ts` and `lib/role-routes.ts` only gain the #424 read route (`/api/visits/[id]/financial-context`, GET). It does not grant cashier or accountant access, and it redacts financial identifiers for clinical roles.
   - All 14 appointment/cashier lines in `app/patients/[id]/page.tsx` are identical to `f8df350f`. #424's changes there add a stricter assistant check.

## Bounded wording
- #426 dry run: the financial preview reads a read-only snapshot. It is not a claim of zero database writes, because `ensureSchema` may run during a cold bootstrap.

## Not established here
- Exact-SHA Docker image proof for this head: the workflow is pending owner approval.
- Railway authentication and operational release checks.
- The deployed Production SHA.
