"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney, type Currency } from "@/lib/money";
import { toWhatsAppNumber } from "@/lib/reminders";
import type { LabDeliveryRisk } from "@/lib/lab-reconciliation";

export interface DebtPatientRow {
  patientId: number;
  patientName: string;
  phone: string | null;
  billedMinor: number;
  openingMinor: number;
  collectedMinor: number;
  dueMinor: number;
  oldestUnpaidDate: string | null;
  ageDays: number;
}

export interface LabSummaryRow {
  partyId: number;
  partyName: string;
  currency: Currency;
  phone: string | null;
  activeOrdersCount: number;
  unsettledOrdersCount: number;
  unsettledCostMinor: number;
}

interface ReceivablesLabsTabProps {
  debtRows: DebtPatientRow[];
  baseCurrency: Currency;
  clinicName: string;
  clinicPhone?: string | null;
  labSummaries: LabSummaryRow[];
  labRisks: LabDeliveryRisk[];
  onOpenCollectForPatient: (patient: { id: number; name: string; dueMinor: number }) => void;
  onOpenLabReconcileForParty: (partyId: number) => void;
}

const AGING_BUCKETS: [string, number, number][] = [
  ["أقل من شهر", 0, 30],
  ["١ – ٣ أشهر", 31, 90],
  ["٣ – ٦ أشهر", 91, 180],
  ["أكثر من ٦ أشهر", 181, Number.MAX_SAFE_INTEGER],
];

export function ReceivablesLabsTab({
  debtRows,
  baseCurrency,
  clinicName,
  clinicPhone,
  labSummaries,
  labRisks,
  onOpenCollectForPatient,
  onOpenLabReconcileForParty,
}: ReceivablesLabsTabProps) {
  const [agingFilter, setAgingFilter] = useState<number | null>(null);
  const [patientSearch, setPatientSearch] = useState("");
  const [showRiskBanner, setShowRiskBanner] = useState(true);

  // حساب إجماليات أعمار الديون
  const agingTotals = useMemo(() => {
    const bucketTotals = AGING_BUCKETS.map(() => 0);
    let total = 0;
    for (const row of debtRows) {
      total += row.dueMinor;
      const idx = AGING_BUCKETS.findIndex(
        ([, min, max]) => row.ageDays >= min && row.ageDays <= max
      );
      if (idx >= 0) bucketTotals[idx] += row.dueMinor;
    }
    return { bucketTotals, total };
  }, [debtRows]);

  // تصفية المرضى المدينين
  const filteredPatients = useMemo(() => {
    return debtRows.filter((row) => {
      if (agingFilter !== null) {
        const [, min, max] = AGING_BUCKETS[agingFilter];
        if (row.ageDays < min || row.ageDays > max) return false;
      }
      if (patientSearch.trim()) {
        const q = patientSearch.toLowerCase();
        const matchesName = row.patientName.toLowerCase().includes(q);
        const matchesPhone = row.phone && row.phone.includes(q);
        if (!matchesName && !matchesPhone) return false;
      }
      return true;
    });
  }, [debtRows, agingFilter, patientSearch]);

  const totalUnsettledLabCost = useMemo(() => {
    return labSummaries.reduce((sum, l) => sum + (l.unsettledCostMinor || 0), 0);
  }, [labSummaries]);

  const totalUnsettledLabOrders = useMemo(() => {
    return labSummaries.reduce((sum, l) => sum + (l.unsettledOrdersCount || 0), 0);
  }, [labSummaries]);

  return (
    <div className="space-y-6">
      {/* ⚠️ إنذار مبكر: تضارب مواعيد المرضى مع أعمال المعامل غير المستلمة */}
      {labRisks.length > 0 && showRiskBanner ? (
        <section
          aria-label="إنذار استباقي لتكامل المعمل والمواعيد"
          className="overflow-hidden rounded-3xl border border-amber-300 bg-gradient-to-r from-amber-50/95 via-orange-50/90 to-rose-50/95 p-4 sm:p-5 shadow-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200/80 pb-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white text-xl shadow-xs animate-bounce">
                🚨
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm sm:text-base font-black text-slate-900">
                    إنذار سريري مالي مبكر: مواعيد قادمة لمرضى وأعمال المعمل لم تصل بعد!
                  </h3>
                  <span className="rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-black text-white">
                    {labRisks.length} حالات تستوجب المتابعة
                  </span>
                </div>
                <p className="text-xs text-slate-600 font-medium mt-0.5">
                  تكامل حركة المعمل مع جدول المواعيد السريرية يمنع تأجيل جلسات المرضى وإحراج العيادة.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/lab"
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                سجل المختبر السريري 🦷
              </Link>
              <button
                type="button"
                onClick={() => setShowRiskBanner(false)}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-600 font-bold"
                title="إخفاء التنبيه مؤقتاً"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {labRisks.map((risk) => (
              <div
                key={`${risk.labOrderId}-${risk.appointmentId}`}
                className="flex flex-col justify-between rounded-2xl border border-amber-200/90 bg-white/95 p-3.5 shadow-2xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <Link
                      href={`/patients/${risk.patientId}`}
                      className="font-black text-xs text-slate-900 hover:text-brand-orange truncate underline decoration-slate-200"
                    >
                      👤 {risk.patientName}
                    </Link>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold ${
                        risk.riskLevel === "critical"
                          ? "bg-rose-100 text-rose-800"
                          : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {risk.riskLevel === "critical" ? "حرج: اليوم/غداً" : "تنبيه تسليم"}
                    </span>
                  </div>

                  <p className="text-xs font-bold text-slate-800 mb-1">
                    🦷 {risk.workType} · معمل {risk.labName}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-slate-500 mb-2 font-mono">
                    <span>📅 الموعد: {risk.appointmentDate} ({risk.appointmentTime})</span>
                    <span>المطلوب: {risk.dueDate}</span>
                  </div>

                  <p className="text-[11px] font-medium text-amber-950 bg-amber-50/80 rounded-xl p-2 mb-2 border border-amber-200/60">
                    {risk.riskMessage}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                  {risk.labPhone ? (
                    <a
                      href={`tel:${risk.labPhone}`}
                      className="text-[11px] font-bold text-sky-700 hover:underline"
                    >
                      اتصال بالمعمل 📞
                    </a>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const lab = labSummaries.find((l) => l.partyName === risk.labName);
                      if (lab) onOpenLabReconcileForParty(lab.partyId);
                    }}
                    className="text-[10px] font-black text-navy-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    تسوية كشف المعمل 📑
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* القسم الأول: ذمم وديون المرضى (Accounts Receivable) */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-100 text-blue-800 text-sm font-black">
                👥
              </span>
              <h3 className="text-base font-black text-navy-900">
                مديونيات المرضى ودورة التحصيل (AR)
              </h3>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              متابعة أرصدة المرضى، أعمار الديون، والتحصيل المباشر بنقرة واحدة
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/finance/debts"
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
            >
              أعمار الديون التفصيلية ↗
            </Link>
            <Link
              href="/finance/plans"
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
            >
              خطط الأقساط العلاجية ↗
            </Link>
          </div>
        </div>

        {/* فلاتر أعمار الديون الأربعة */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <button
            type="button"
            onClick={() => setAgingFilter(null)}
            className={`rounded-2xl border p-2.5 text-right transition-all ${
              agingFilter === null
                ? "border-navy-900 bg-navy-900 text-white shadow-xs"
                : "border-slate-200 bg-slate-50/80 hover:bg-slate-100 text-slate-700"
            }`}
          >
            <span className="block text-[10px] font-medium opacity-80">كافة المديونيات</span>
            <span className="block text-sm font-mono font-black">
              {formatMoney(agingTotals.total, baseCurrency)}
            </span>
            <span className="text-[10px] font-bold">({debtRows.length} مريض)</span>
          </button>

          {AGING_BUCKETS.map(([label], idx) => {
            const isSelected = agingFilter === idx;
            const amount = agingTotals.bucketTotals[idx];
            return (
              <button
                key={label}
                type="button"
                onClick={() => setAgingFilter(idx)}
                className={`rounded-2xl border p-2.5 text-right transition-all ${
                  isSelected
                    ? "border-brand-orange bg-brand-orange text-white shadow-xs"
                    : "border-slate-200 bg-slate-50/80 hover:bg-slate-100 text-slate-700"
                }`}
              >
                <span className="block text-[10px] font-medium opacity-80">{label}</span>
                <span className="block text-sm font-mono font-black">
                  {formatMoney(amount, baseCurrency)}
                </span>
                <span className="text-[10px] font-bold">
                  ({debtRows.filter((r) => {
                    const [, min, max] = AGING_BUCKETS[idx];
                    return r.ageDays >= min && r.ageDays <= max;
                  }).length} مريض)
                </span>
              </button>
            );
          })}
        </div>

        {/* حقل البحث بالاسم أو الهاتف */}
        <div className="mb-3">
          <input
            value={patientSearch}
            onChange={(e) => setPatientSearch(e.target.value)}
            placeholder="بحث باسم المريض أو رقم الهاتف…"
            className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium outline-none focus:border-blue-500 focus:bg-white"
          />
        </div>

        {/* جدول المرضى المدينين */}
        {filteredPatients.length === 0 ? (
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
            {patientSearch || agingFilter !== null
              ? "لا توجد مديونيات مطابقة لمعايير البحث المحددة."
              : "لا توجد مديونيات معلقة على المرضى حالياً."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200/80 text-slate-500 font-bold">
                  <th className="pb-2.5 ps-2">المريض</th>
                  <th className="pb-2.5">المفوتر</th>
                  <th className="pb-2.5">المحصل</th>
                  <th className="pb-2.5">المستحق (الدين)</th>
                  <th className="pb-2.5">عمر الدين</th>
                  <th className="pb-2.5 text-center">الإجراء المالي المباشر</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPatients.slice(0, 15).map((row) => {
                  const waPhone = toWhatsAppNumber(row.phone);
                  const waText = encodeURIComponent(
                    `مرحبًا ${row.patientName}، تحية طيبة من ${clinicName}.\nنود تذكيركم بلطف بوجود رصيد مستحق بقيمة ${formatMoney(
                      row.dueMinor,
                      baseCurrency
                    )} عن الخدمات المقدمة لكم.\nيسعدنا تواصلكم لترتيب السداد، ودمتم بصحة وعافية.${
                      clinicPhone ? `\nللتواصل: ${clinicPhone}` : ""
                    }`
                  );

                  return (
                    <tr key={row.patientId} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2.5 ps-2">
                        <Link
                          href={`/patients/${row.patientId}`}
                          className="font-black text-navy-900 hover:text-brand-orange underline decoration-slate-200"
                        >
                          {row.patientName}
                        </Link>
                        {row.phone ? (
                          <span className="block text-[10px] text-slate-500 font-mono">
                            {row.phone}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 font-mono text-slate-600">
                        {formatMoney(row.billedMinor, baseCurrency)}
                      </td>
                      <td className="py-2.5 font-mono text-emerald-700 font-bold">
                        {formatMoney(row.collectedMinor, baseCurrency)}
                      </td>
                      <td className="py-2.5 font-mono text-rose-700 font-black">
                        {formatMoney(row.dueMinor, baseCurrency)}
                      </td>
                      <td className="py-2.5 font-mono text-[11px] text-slate-500">
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            row.ageDays > 90
                              ? "bg-rose-100 text-rose-800"
                              : row.ageDays > 30
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {row.ageDays} يوم
                        </span>
                      </td>
                      <td className="py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {/* زر التحصيل بنقرة واحدة */}
                          <button
                            type="button"
                            onClick={() =>
                              onOpenCollectForPatient({
                                id: row.patientId,
                                name: row.patientName,
                                dueMinor: row.dueMinor,
                              })
                            }
                            className="flex items-center gap-1 rounded-xl bg-emerald-600 px-2.5 py-1 text-[11px] font-black text-white hover:bg-emerald-700 shadow-2xs transition-colors"
                          >
                            <span>💳</span>
                            <span>تحصيل</span>
                          </button>

                          {/* زر واتساب */}
                          {waPhone ? (
                            <a
                              href={`https://wa.me/${waPhone}?text=${waText}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
                            >
                              <span>💬</span>
                              <span>تذكير</span>
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* القسم الثاني: مستحقات معامل الأسنان (Accounts Payable - Dental Labs) */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-purple-100 text-purple-800 text-sm font-black">
                🦷
              </span>
              <h3 className="text-base font-black text-navy-900">
                حسابات ومستحقات مختبرات الأسنان (Dental Labs AP)
              </h3>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              مطابقة كشوفات التركيبات والزراعة وسداد مستحقات الفنيين والمعامل المعتمدة
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-xl bg-purple-50 border border-purple-200 px-3 py-1.5 text-xs font-mono font-black text-purple-900">
              إجمالي المستحق: {formatMoney(totalUnsettledLabCost, baseCurrency)}
            </span>
            <Link
              href="/finance/lab-accounting"
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
            >
              كشوفات المختبرات الموسعة ↗
            </Link>
          </div>
        </div>

        {labSummaries.length === 0 ? (
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
            لا توجد مختبرات مسجلة أو مستحقات معلقة حالياً.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {labSummaries.map((lab) => (
              <div
                key={lab.partyId}
                className="flex flex-col justify-between rounded-2xl border border-slate-200/90 bg-slate-50/50 p-4 transition-all hover:border-purple-300 hover:bg-white shadow-2xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <h4 className="font-black text-xs text-navy-900">{lab.partyName}</h4>
                      {lab.phone ? (
                        <a
                          href={`tel:${lab.phone}`}
                          className="text-[10px] text-slate-500 font-mono hover:text-sky-700"
                        >
                          📞 {lab.phone}
                        </a>
                      ) : null}
                    </div>
                    <span className="rounded-md bg-purple-100 px-2 py-0.5 text-[10px] font-black text-purple-900">
                      {lab.unsettledOrdersCount} عمل معلق
                    </span>
                  </div>

                  <div className="space-y-1 text-[11px] mb-3">
                    <div className="flex justify-between text-slate-600">
                      <span>الأعمال النشطة:</span>
                      <span className="font-mono font-bold">{lab.activeOrdersCount} طلب</span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>الرصيد غير المسدد:</span>
                      <span className="font-mono font-black text-purple-900">
                        {formatMoney(lab.unsettledCostMinor, lab.currency)}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenLabReconcileForParty(lab.partyId)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-purple-700 py-2 text-xs font-black text-white hover:bg-purple-800 transition-colors shadow-2xs"
                >
                  <span>📑</span>
                  <span>تسوية كشف المعمل</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* القسم الثالث: بنود المصروفات التشغيلية والجهات */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-black text-navy-900">
              بنود المصروفات التشغيلية والموازنات (OPEX)
            </h4>
            <p className="text-[11px] text-slate-500">
              رقابة الموازنات التقديرية التشغيلية الشهرية ونسب الانحراف وسجلات الموردين
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/finance/expense-categories"
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
            >
              بنود وموازنات المصروفات ↗
            </Link>
            <Link
              href="/finance/parties"
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
            >
              سجل الجهات والموردين ↗
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
