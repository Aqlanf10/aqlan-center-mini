import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as db from "../lib/db";

/**
 * لماذا سقط `verify:deletions` أصلًا؟
 *
 * لأنه كان ينادي `deleteExpense` — دالةً حُذفت من الكود يوم صار سند الصرف حدثًا
 * ماليًّا تاريخيًّا لا يُمحى (هجرة 0005 وP1-FIX-3). الرحلة تخلّفت عن النظام سنةً
 * كاملةً بلا أن يشعر أحد، لأن لا أحد كان يشغّلها.
 *
 * تشغيلُها في CI يمنع تكرار ذلك من جهة الرحلة. وهذا الاختبار يمنعه من الجهة
 * المقابلة — أن يعود الحذفُ نفسه إلى الكود تحت أي اسم:
 *
 *   ١) لا دالةَ حذفٍ مُصدَّرة لأيّ جدولٍ ماليّ تاريخيّ.
 *   ٢) ولا جملةَ `DELETE FROM` على تلك الجداول في `lib/` أو `app/`.
 *   ٣) ومسارُ التصحيح المشروع — `voidExpense` — موجودٌ فعلًا، فلا يُمنع الحذف
 *      ويبقى المستخدم بلا طريقةٍ لتصحيح خطئه.
 *
 * الحارس البنيويّ في القاعدة يردّ الحذف على كل حال؛ وهذا يردّه في المراجعة قبل
 * أن يصل إلى قاعدة الإنتاج فيسقط هناك بخطأٍ لا يفهمه أحد.
 */

const APPEND_ONLY_TABLES = ["payments", "expenses", "inventory_movements", "audit_log"];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** يُسقط التعليقات قبل البحث: ذكرُ الحذف شرحًا لمنعه ليس حذفًا. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("السجل المالي append-only — من جهة الشيفرة لا القاعدة وحدها", () => {
  it("لا دالةَ حذفٍ مُصدَّرة لجدولٍ ماليّ تاريخيّ", () => {
    const forbidden = Object.keys(db).filter((name) =>
      /^(delete|purge|remove|drop)(Expense|Payment|Refund|InventoryMovement|AuditLog)s?$/.test(name));
    expect(forbidden, `دوالُّ حذفٍ عادت إلى الواجهة: ${forbidden.join("، ")}`).toEqual([]);
  });

  it("ومسارُ التصحيح المشروع موجود — المنعُ بلا بديلٍ عطبٌ آخر", () => {
    expect(typeof db.voidExpense).toBe("function");
    expect(typeof db.getExpense).toBe("function");
  });

  it("ولا جملةَ DELETE على تلك الجداول في lib/ أو app/", () => {
    const roots = ["lib", "app"].map((dir) => fileURLToPath(new URL(`../${dir}`, import.meta.url)));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const source = withoutComments(readFileSync(file, "utf8"));
        for (const table of APPEND_ONLY_TABLES) {
          const pattern = new RegExp(`DELETE\\s+FROM\\s+"?${table}"?\\b`, "i");
          if (pattern.test(source)) offenders.push(`${file.split("/").slice(-2).join("/")} → ${table}`);
        }
      }
    }
    expect(offenders, `حذفٌ مباشر لسجلٍّ ماليّ: ${offenders.join("، ")}`).toEqual([]);
  });
});
