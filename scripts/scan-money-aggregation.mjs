#!/usr/bin/env node
/**
 * (P-01) حارس تجميع المال — مدخل سطر الأوامر.
 *
 *   node --import tsx scripts/scan-money-aggregation.mjs
 *
 * يمسح كود المنتج (lib/ app/ components/ scripts/) بحثًا عن تجميع SUM على
 * أعمدة المال بلا بعد العملة — انحدار P0-1 لا يعود من نافذته. الاختبارات
 * (__tests__) خارج النطاق عمدًا: هي تُظهر الدلالات بتعمدٍ (بما فيها الفرق
 * بين الجمع الحلال والممزوج).
 *
 * الاستثناءات الموثَّقة في MONEY_GUARD_ALLOWLIST — كلٌّ منها بسببٍ مكتوب.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const {
  scanMoneyAggregation,
  MONEY_GUARD_ALLOWLIST,
} = await import("../lib/money-aggregation-guard.ts");

const SCAN_ROOTS = ["lib", "app", "components", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs"]);

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      files.push(full);
    }
  }
  return files;
}

const allowlistFor = (relativePath) =>
  MONEY_GUARD_ALLOWLIST.filter((entry) => relativePath.endsWith(entry.file));

const violations = [];
const allowlisted = [];
for (const root of SCAN_ROOTS) {
  const files = listSourceFiles(join(repoRoot, root));
  for (const file of files) {
    const relativePath = relative(repoRoot, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const violation of scanMoneyAggregation(source, relativePath)) {
      // المطابقة على نص الجملة كاملًا لا على مقتطف العرض — الاستثناء موضعٌ
      // واحد مُسبَّب بمعناه الدلاليّ، والجملة الطويلة قد يتجاوز فيها موضع
      // الجمع المئتي حرفٍ الأولى.
      const match = allowlistFor(relativePath).find((entry) =>
        (violation.sqlSegment ?? violation.sqlExcerpt).includes(entry.contains),
      );
      if (match) {
        allowlisted.push({ ...violation, reason: match.reason });
      } else {
        violations.push(violation);
      }
    }
  }
}

if (allowlisted.length > 0) {
  console.log(`استثناءات موثَّقة (${allowlisted.length}):`);
  for (const entry of allowlisted) {
    console.log(`  · ${entry.file}:${entry.line} [${entry.column}] — ${entry.reason}`);
  }
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} تجميع مالٍ بلا بعد عملة (حارس P-01):`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} [${violation.column}] — ${violation.reason}`);
    console.error(`    ${violation.sqlExcerpt}`);
  }
  process.exit(1);
}

console.log("\n✓ حارس تجميع المال: لا جمع عبر العملات في كود المنتج");
