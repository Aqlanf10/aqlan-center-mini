"use client";

import { useMemo, useState } from "react";
import { clinicDateString } from "@/lib/schedule";

/**
 * تصدير البيانات.
 *
 * ليس تقريرًا — التقارير في شاشاتها. هذا **نسخة احتياطية يقرأها إنسان**، وملف
 * يُرحَّل به إلى برنامج آخر حين يجهز النظام الأساسي. بيانات عيادة تعمل أربعة أشهر بلا
 * ملف يخرج منها رهانٌ على ألّا يخطئ أحد — والرهان يُخسر.
 */

const TABLES: { key: string; label: string; dated: boolean; hint?: string }[] = [
  { key: "patients", label: "المرضى", dated: false, hint: "كل المرضى — لا يتأثر بالمدى" },
  { key: "appointments", label: "المواعيد", dated: true },
  { key: "visits", label: "الزيارات", dated: true },
  { key: "invoices", label: "الفواتير", dated: true },
  { key: "invoice_items", label: "بنود الفواتير", dated: true, hint: "بند لكل سطر — للتحليل" },
  { key: "payments", label: "سندات القبض", dated: true },
  { key: "expenses", label: "سندات الصرف", dated: true },
  { key: "payables", label: "الالتزامات", dated: true },
  { key: "lab_orders", label: "أعمال المختبر", dated: true },
  { key: "opening_balances", label: "الأرصدة الافتتاحية", dated: true, hint: "ما كان على المرضى قبل بدء النظام" },
  { key: "journal", label: "دفتر اليومية", dated: true, hint: "كل القيود بطرفيها — للمحاسب" },
];

export default function ExportPage() {
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">النسخ والتصدير</h1>
        <p className="text-xs text-slate-500">نسخة كاملة للاستعادة، وجداول CSV للمراجعة</p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>

      {/* النسخة الكاملة فوق كل شيء: هي وحدها التي تُعيد العيادة إن ضاع كل شيء.
          وملفات CSV تحتها للمراجعة — تُقرأ ولا تُستعاد. */}
      <section className="mb-5 rounded-2xl border-2 border-navy-800 bg-white p-4" aria-label="نسخة كاملة">
        <h2 className="text-sm font-extrabold">نسخة احتياطية كاملة</h2>
        <p className="mt-1 mb-3 text-[11px] font-bold leading-5 text-slate-500">
          المرضى والمواعيد والفواتير والسندات والدفاتر في ملف واحد. هذا هو الملف الذي
          تُستعاد به العيادة لو ضاع كل شيء —
          <span className="text-navy-800"> وملفات CSV تحته للقراءة لا للاستعادة.</span>
        </p>
        <a href="/api/backup"
          className="block rounded-xl bg-navy-800 py-2.5 text-center text-sm font-extrabold text-white">
          نزّل النسخة الكاملة الآن
        </a>
        <p className="mt-2 text-[11px] font-bold leading-5 text-slate-400">
          خذها في نهاية كل يوم عمل. والملف يحمل بيانات كل مرضاك — احفظه في مكان تثق به.
        </p>

        {/*
          * الصور خارج هذا الملف — ويُقال صراحةً.
          *
          * الأشعة على القرص لا في القاعدة (الدستور، المحظور ٨)، فنسخةُ القاعدة
          * وحدها ليست نسخةً كاملة. وأسوأ من نقصها أن يظنّها صاحب العيادة كاملة،
          * فيكتشف يوم الكارثة أن سنواتٍ من الأشعة ليست فيها.
          */}
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-extrabold text-navy-800">
            والأشعة ليست في الملف أعلاه — نزّلها معه
          </p>
          <p className="mt-1 mb-2 text-[11px] leading-5 text-slate-500">
            صور الأشعة والمستندات محفوظة على القرص لا داخل قاعدة البيانات، فلا تحملها
            نسخة SQL. هذا أرشيفها — مجلّدٌ لكل مريض برقم ملفّه، يُفتح بـ 7-Zip أو
            WinRAR بلا حاجة إلى البرنامج.
          </p>
          <a href="/api/backup/documents"
            className="block rounded-xl border border-navy-800 bg-white py-2 text-center text-xs font-extrabold text-navy-800">
            نزّل أرشيف الأشعة والمستندات
          </a>
        </div>
      </section>

      <h2 className="mb-2 text-sm font-extrabold">جداول CSV — للمراجعة في Excel</h2>

      <div className="mb-4 flex flex-wrap gap-2">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">من</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">إلى</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>

      <ul className="space-y-2">
        {TABLES.map((table) => (
          <li key={table.key} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="min-w-[9rem] flex-1">
              <p className="text-sm font-extrabold">{table.label}</p>
              <p className="text-[11px] text-slate-400">
                {table.hint ?? (table.dated ? "ضمن المدى المحدد" : "")}
              </p>
            </div>
            {/* رابط لا زر: التنزيل يبدأ من المتصفّح مباشرة بلا جافاسكربت يجمع الملف
                في الذاكرة، فلا ينهار على ملف كبير في هاتف. */}
            <a
              href={`/api/export?table=${table.key}&from=${from}&to=${to}`}
              className="shrink-0 rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white"
            >
              نزّل CSV
            </a>
          </li>
        ))}
      </ul>

      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-bold text-amber-900">احفظ النسخة خارج الجهاز</p>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
          ملفٌ على نفس الحاسب الذي قد يتعطّل ليس نسخة احتياطية. أرسلها إلى بريدك أو
          إلى مجلد على السحابة بعد كل تنزيل. ونزّلها <strong>شهريًا على الأقل</strong> — وقبل أي
          تغيير كبير في البرنامج. والنسخة الكاملة ملفّان لا ملفّ: قاعدة البيانات
          وأرشيف الأشعة.
        </p>
      </div>
    </main>
  );
}
