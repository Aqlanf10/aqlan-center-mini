#!/usr/bin/env node
/**
 * npm run db:ortho-reconcile -- --database <name> [--apply --expect-fingerprint <sha256> --actor <name> --reason <text>]
 *
 * مصالحة صريحة لكائنات 0051 غير المسجّلة (lib/ortho-legacy-reconciliation.ts). بلا --apply
 * تقرير فقط ولا يكتب شيئًا. التطبيق يحتاج تفويضًا منفصلًا والبصمة التي راجعها المشغّل.
 * لا تعمل من الإقلاع، ولا تحذف ولا تعدّل أي كائن أو صف، ولا تضع adopted=true.
 * exit 0 = تقرير مؤهّل أو تطبيق تمّ | 2 = غير مؤهّل/مرفوض | 1 = خطأ.
 */
import "./load-env.mjs";

async function main(): Promise<number> {
  const { parseReconcileArgs, reconcileOrthoStrategyLegacy } = await import("../lib/ortho-legacy-reconciliation");
  const { getPool, resetPoolForTesting } = await import("../lib/db");
  const options = parseReconcileArgs(process.argv.slice(2));
  try {
    const report = await reconcileOrthoStrategyLegacy(getPool(), options);
    console.log(JSON.stringify(report, null, 2));
    return (options.apply ? report.applied : report.eligible) ? 0 : 2;
  } finally { await resetPoolForTesting(); }
}

main().then(code => process.exit(code), error => {
  console.error(error instanceof Error && /^ORTHO_RECONCILE_[A-Z_]+/.test(error.message) ? error.message : "ORTHO_RECONCILE_FAILED");
  process.exit(1);
});
