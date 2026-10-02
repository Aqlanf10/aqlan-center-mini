# Expense catalogue visibility containment

## Status and release boundary

**DONE for this bounded containment slice.** PR202 merged as
`23d3bc3663ab0110947993bc9e581eabffd66064`, tree `61ced2b34ff56931d287d28484c8470f39ab8b28`.
The shared projection, both budget-manager mounts and GET integration shipped atomically;
PR198's conflict-error import and all POST/PATCH/DELETE known-409 handling are preserved.

[Exact CI 37060650003](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37060650003) passed
3,780 unit / 841 PostgreSQL / 587 HTTP tests and 20 operational journeys. All nine new browser
cases and 120 combined checks passed; independent/root review cleared (review `5396750101`).
All three allowlisted PNGs in artifact `11250794239` were inspected by root; archive SHA-256
`7fa32eb7ae9531c3b2683d6b4e9b6723961ee2ea7982e880138f967da3e005d5`.
Railway deployment `13e63773-7984-4b47-b885-d7f9e30a11e4` reached SUCCESS at
2026-10-02 20:57:36.989 UTC on the exact merge; root verified HTTP 200/ready:true before 21:05 UTC.

The local/pre-publication observations below are historical. No local browser execution,
new live grant, schema/history repair or broad staff-permission rollout is claimed.

## Verified defect and deliberately preserved policy

`GET /api/finance/expense-categories` previously required only a valid session and
returned clinic-wide monthly/annual budgets, actual spend, counts, variances,
ratios and the total summary. The real proxy permits its GET for doctors and
allowlisted financial roles; a restricted assistant is denied before the handler.

- Doctor `canViewExpenses=false` is an existing explicit denial, enforced by
  `/api/expenses`; this catalogue response bypassed it
- Accountant `financeAccess.viewReports=false` denies reports/accounting routes,
  but previously did not remove this endpoint's budget report
- Reception and cashier retain their existing full-read contracts. Reception's
  default doctor-style flag and cashier `createExpenses=false` do not establish
  expense-read revocation. No new live policy is inferred from those flags
- Admin remains full access. There is no new manager role, grants UI, permission
  editor, identity binding or role-model redesign

The new pure `expenseCatalogueAccess` uses fresh doctor permissions and normalized
accountant report access. Missing/failed doctor lookup yields catalogue-only data.
Revenue, clinic-finance, cost and profit flags do not imply expense permission.
Other roles remain denied; no session remains 401.

## Projection and operational compatibility

`projectExpenseCategories` explicitly allowlists both response modes. Catalogue
mode keeps exactly `id`, `key`, `name`, `categoryGroup`, `accountCode`, `accountName`
and `isActive` for each category, plus the base currency. It omits every budget,
amount, count, variance/percentage, summary and free-text description. Denied data
is absent rather than a zero, an empty total or a null amount; reconstructive
ratios cannot disclose a hidden amount by subtraction.

Full mode preserves existing values and static account choices, with
`visibility: "full"`; legitimate zeros remain zeros. Unknown future fields do not
pass through and the input is not mutated. No aggregate SQL, database schema,
financial history or posting behavior is changed by this slice.

The two actual GET consumers remain compatible:

- `app/lab/page.tsx` and its `LabOrderAccountingModal` need only the seven ordinary
  catalogue fields. Their category selection and account mapping remain available
- `ExpenseCategoriesManager` is mounted by both `/finance/expense-categories` and
  `/settings/finance-expenses`. Catalogue-only mode displays operational labels,
  without the budget table, editing controls, report modal or Excel export
- Ordinary expense creation uses static `EXPENSE_CATEGORIES` and is unchanged

## Reload and draft behavior

A reload clears the previous financial payload, report/create/edit modals,
success message and unsaved inline budget/account/status drafts before fetching.
**Unsaved drafts are intentionally discarded on reload, period/filter change or
observed session-policy change; they are not automatically saved or carried into
a newly authorized/restricted response.** This is a containment choice and a
visible loss of unsubmitted edits, not a persistence guarantee. Unit and mandatory
browser regressions verify recovery restores server values without a stale save
bar or reopened report.

A response is bound to the requested period/filter and observed session identity
and expense/report flags. Abort plus revision checks prevent stale fetch/JSON
completion, obsolete errors or an unmount from restoring old data. 401/403 and
reduced responses remove financial output from screen and print. This does not
instantly erase information already delivered to an idle page without a reload
or observed session event; broader revocation propagation is outside this slice.

## Verification and mandatory browser evidence

Local synthetic evidence before publication:

- 105 tests across projection/manager, actual integrated GET and existing
  role/report suites passed together on the refreshed main198-equivalent tree
- The actual integrated GET passes 17 real-proxy/handler tests, including
  genuine synthetic HMAC verification and omission after permission revocation
- Focused ambient TypeScript checking, including explicit Next/image ambient
  declarations and all browser source, passed; DB DTOs are
  copied from source and the external database/session boundaries are declared
- Focused lint has no new errors/warnings; two original manager unused-variable
  warnings remain. No full build or local browser was run; full typechecking
  was not retried after the earlier audit process ended with exit 137

`__tests__/security-http/expense-catalogue-visibility-ui.test.ts` is discovered by
the existing mandatory security-HTTP CI job, not an opt-in script. Its nine cases
use the real built Next pages and the isolated harness's synthetic admin session.
Catalogue, lab and export data are fixtures; unexpected API writes and external
requests are blocked. Cases cover:

1. Catalogue-only finance and settings pages at 1280px and 390px, with screen and
   print financial omissions and usable category/account labels (four cases)
2. Admin full report and actual Excel serialization/print handlers. Synthetic
   export Blobs are intercepted in memory; no file download, real print,
   private-data export or external transmission occurs
3. Loss of full-report access with a report modal open and an unsaved budget edit.
   A synthetic native month event invokes the real reload handler behind the
   modal; it changes no session/grant or server state. The restricted response
   closes/removes the report and drafts; later full recovery uses server values
4. HTTP 401 and 403 clear loaded output and allow safe catalogue-only retry
5. The real lab new-order form can select its category and account mapping from
   catalogue-only fields, without patient selection or submitting an order

The CI artifact `expense-catalogue-visibility-ui-screenshots` allowlists exactly:

- `.settings-ui-artifacts/expense-catalogue-restricted-1280.png`
- `.settings-ui-artifacts/expense-catalogue-restricted-390.png`
- `.settings-ui-artifacts/expense-catalogue-revoked-open-report.png`

Each capture is limited to the synthetic catalogue panel. Missing images fail the
artifact step. No broad hidden-directory upload is added. These cases are authored
and typechecked locally, **not locally executed**. The exact-head CI and
visual-inspection release gates subsequently passed as recorded above. They prove UI contract handling, while
server admission/serialization is covered separately by the GET/proxy regressions.
