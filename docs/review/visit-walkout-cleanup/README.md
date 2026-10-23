# Standalone visit walkout: snapshot cleanup

## Defect
- **Where:** without a caller snapshot, `visitWalkout()` (`lib/db.ts`) opened its own `REPEATABLE READ READ ONLY` transaction. The printed walkout page `app/print/walkout/[id]/page.tsx` calls it this way.
- **What went wrong:** on a read failure it swallowed a failed `ROLLBACK` (`.catch(() => undefined)`) and then always called `client.release()`. A client in an unknown transaction state could go back to the pool.
- **Class:** the same defect as the opening-correction preview, fixed in `bb89043b`.

## Fix
- The standalone path now uses the shared `withFinancialReadSnapshot` helper. It keeps the original error and discards the client (`release(true)`) when `ROLLBACK` fails.
- The shared-local flag is **not** passed, so the path still always gets a dedicated client and transaction, as before.
- Unchanged: the caller-snapshot branch, walkout arithmetic, the clinic-day rule and the print layout.

## Evidence (local PostgreSQL 18, synthetic data)
- **`__tests__/postgres/visit-walkout-snapshot-cleanup.test.ts`:**
  - normal → `COMMIT`, client released normally;
  - read fails → `ROLLBACK`, original error, client released normally;
  - read and rollback fail → original error, client **discarded**, pool still usable;
  - caller snapshot → no `BEGIN`/`COMMIT`/`ROLLBACK`, no `connect`, no `release`.
- **`red-before-fix.log`:** on the unfixed code only the rollback-failure case fails (`expected [ undefined ] to deeply equal [ true ]`). The other three already passed, so the caller-snapshot behaviour is unchanged by this fix.
- **After the fix:** 48/48 across the cleanup, walkout-lineage, walkout-pool, reception-checkout, checkout-source-matrix and clinic-day-boundary PostgreSQL files. 85/85 in the unit files that reference the walkout or its print page. `tsc` is clean.
