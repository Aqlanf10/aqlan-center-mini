"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CURRENCIES, formatMoney, type Currency } from "@/lib/money";
import { CATEGORY_LABEL } from "@/lib/services-catalog";
import { useSession } from "@/components/SessionProvider";

/**
 * (COMM-DETAIL-1 · F-8) تفصيل العمولة تحت شاشة العمولات — سطرٌ لكل حصة طبيب كما حسبها
 * المحرّك الواحد: المريض، الفاتورة، الخدمة، التخصص، الحالة، الحصة، الخصومات، النسبة
 * ومصدرها، والمستحق. المرشّحات: الطبيب والتخصص والعملة (والفترة من الشاشة الأم).
 * الطبيب الشخصي يرى سطوره وحده — يفرضه الخادم لا هذه الشاشة.
 */

interface DetailLine {
  invoiceId: number; invoiceNumber: string | null; visitId: number | null; clinicDate: string;
  patientId: number; patientName: string; patientNumber: string | null;
  doctorId: number; doctorName: string; currency: Currency;
  serviceName: string | null; categoryLabel: string | null;
  caseId: number | null; caseTitle: string | null; planId: number | null; planTitle: string | null;
  amountMinor: number; labCostMinor: number; materialCostMinor: number;
  labDeducted: boolean; materialDeducted: boolean; baseMinor: number;
  percent: number; ruleSourceLabel: string; accruedMinor: number; earnedMinor: number;
  invoiceNetMinor: number; invoiceCoveredMinor: number;
}
interface Unallocated {
  movementId: number; patientName: string | null; invoiceId: number; itemName: string; costMinor: number; reasonLabel: string;
}
interface Finding { doctorName: string; ruleName: string; percent: number; status: "ambiguous" | "unresolved"; candidateServiceIds: number[] }
interface DetailPayload {
  lines: DetailLine[]; unallocatedMaterials: Unallocated[]; serviceRateFindings: Finding[]; isPersonalOnly: boolean;
  rows: Array<{ doctorId: number; doctorName: string }>;
}

type Shape = Record<string, unknown>;
const isShape = (value: unknown): value is Shape => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);
const has = (shape: Shape, keys: string[], test: (value: unknown) => boolean) => keys.every((key) => test(shape[key]));

function isLine(value: unknown): value is DetailLine {
  return isShape(value)
    && has(value, ["invoiceId", "patientId", "doctorId", "amountMinor", "labCostMinor", "materialCostMinor", "baseMinor",
      "percent", "accruedMinor", "earnedMinor", "invoiceNetMinor", "invoiceCoveredMinor"], isNumber)
    && has(value, ["clinicDate", "patientName", "doctorName", "ruleSourceLabel"], isText)
    && has(value, ["invoiceNumber", "patientNumber", "serviceName", "categoryLabel", "caseTitle", "planTitle"], isTextOrNull)
    && has(value, ["visitId", "caseId", "planId"], isNumberOrNull)
    && has(value, ["labDeducted", "materialDeducted"], (field) => typeof field === "boolean")
    && (CURRENCIES as readonly unknown[]).includes(value.currency);
}

/** عقد الردّ كاملًا قبل أي عرض: ردٌّ ناقص لا يُعرض جزؤه ولا تُخترع له أصفار. */
function parseDetailPayload(payload: unknown): DetailPayload | null {
  if (!isShape(payload) || typeof payload.isPersonalOnly !== "boolean") return null;
  const { lines, rows, unallocatedMaterials, serviceRateFindings } = payload;
  if (!Array.isArray(lines) || !lines.every(isLine)) return null;
  if (!Array.isArray(rows) || !rows.every((row) => isShape(row) && isNumber(row.doctorId) && isText(row.doctorName))) return null;
  if (!Array.isArray(unallocatedMaterials) || !unallocatedMaterials.every((item) => isShape(item)
    && has(item, ["movementId", "invoiceId", "costMinor"], isNumber)
    && has(item, ["itemName", "reasonLabel"], isText) && isTextOrNull(item.patientName))) return null;
  if (!Array.isArray(serviceRateFindings) || !serviceRateFindings.every((finding) => isShape(finding)
    && has(finding, ["doctorName", "ruleName"], isText) && isNumber(finding.percent)
    && (finding.status === "ambiguous" || finding.status === "unresolved")
    && Array.isArray(finding.candidateServiceIds) && finding.candidateServiceIds.every(isNumber))) return null;
  return payload as unknown as DetailPayload;
}

type DetailState =
  | { key: string; status: "ready"; data: DetailPayload }
  | { key: string; status: "error"; message: string; denied: boolean };

/* رسائلنا نحن — لا نصّ استثناء ولا رسالة خادمٍ خام قد تحمل تفاصيل داخلية. */
const FAILURE = {
  network: "تعذّر الاتصال بالخادم لتحميل تفصيل العمولة.",
  session: "انتهت الجلسة. سجّل الدخول من جديد.",
  forbidden: "غير مصرّح لك بعرض تفصيل العمولات.",
  server: "تعذّر تحميل تفصيل العمولة.",
  invalid: "وصل ردٌّ ناقص أو غير صالح من الخادم — لم يُعرض شيءٌ منه.",
} as const;

export function CommissionDetailPanel({ from, to, base }: { from: string; to: string; base: Currency }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [doctorId, setDoctorId] = useState<string>("");
  const [specialty, setSpecialty] = useState<string>("");
  const [currency, setCurrency] = useState<string>("");
  const [doctors, setDoctors] = useState<Array<{ id: number; name: string }>>([]);
  const [personalOnly, setPersonalOnly] = useState(false);
  /* كل فتحٍ للوحة وكل «إعادة محاولة» نطاقٌ جديد: لا تُعرض نتيجةٌ قديمة ولو عادت المرشّحات نفسها. */
  const [openEpoch, setOpenEpoch] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DetailState | null>(null);

  /* ملكية النتيجة: مفتاحٌ يجمع المستخدم والفترة والمرشّحات وفتح اللوحة والمحاولة. كل تغييرٍ فيه —
     أو إغلاق اللوحة — يلغي الطلب السابق فورًا (AbortController)، ويتقدّم رقم الجيل في التنظيف
     نفسه لا عند بدء التحميل التالي، ولا تُعرض نتيجةٌ إلا إن طابق مفتاحُها المفتاحَ الحالي. */
  const requestKey = JSON.stringify([session?.username ?? "", session?.role ?? "", from, to, doctorId, specialty, currency, openEpoch, attempt]);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const owns = () => !controller.signal.aborted && generation === generationRef.current;
    void (async () => {
      let next: DetailState;
      try {
        const query = new URLSearchParams({ detail: "1", from, to });
        if (doctorId) query.set("doctorId", doctorId);
        if (specialty) query.set("specialty", specialty);
        if (currency) query.set("currency", currency);
        const response = await fetch(`/api/finance/commissions?${query}`, { cache: "no-store", signal: controller.signal });
        const payload: unknown = await response.json().catch(() => undefined);
        if (!owns()) return;
        if (response.status === 401) next = { key: requestKey, status: "error", message: FAILURE.session, denied: true };
        else if (response.status === 403) next = { key: requestKey, status: "error", message: FAILURE.forbidden, denied: true };
        else if (!response.ok) next = { key: requestKey, status: "error", message: FAILURE.server, denied: false };
        else {
          const data = parseDetailPayload(payload);
          next = data
            ? { key: requestKey, status: "ready", data }
            : { key: requestKey, status: "error", message: FAILURE.invalid, denied: false };
        }
      } catch {
        if (!owns()) return;
        next = { key: requestKey, status: "error", message: FAILURE.network, denied: false };
      }
      setResult(next);
      if (next.status === "ready") {
        setPersonalOnly(next.data.isPersonalOnly);
        if (!doctorId) {
          const seen = new Map<number, string>();
          for (const line of next.data.lines) seen.set(line.doctorId, line.doctorName);
          setDoctors([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ar")));
        }
      }
    })();
    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [open, requestKey, from, to, doctorId, specialty, currency]);

  /* ما يُعرض: نتيجةُ المفتاح الحالي وحده — وإلا فالتحميل جارٍ لهذا النطاق. */
  const current = result !== null && result.key === requestKey ? result : null;
  const data = current?.status === "ready" ? current.data : null;
  const loading = open && current === null;

  const totals = useMemo(() => {
    const map = new Map<Currency, { accrued: number; earned: number }>();
    for (const line of data?.lines ?? []) {
      const entry = map.get(line.currency) ?? { accrued: 0, earned: 0 };
      entry.accrued += line.accruedMinor;
      entry.earned += line.earnedMinor;
      map.set(line.currency, entry);
    }
    return CURRENCIES.filter((code) => map.has(code)).map((code) => [code, map.get(code)!] as const);
  }, [data]);

  /* رابط الطباعة يتبع نتيجةً معتمدة للنطاق الحالي فقط: معطّلٌ أثناء التحميل والفشل وفقد الصلاحية.
     وصفحة الطباعة تتحقّق من الصلاحية مستقلّةً على الخادم على أي حال. */
  const printDoctor = data
    ? data.isPersonalOnly ? data.lines[0]?.doctorId ?? data.rows[0]?.doctorId ?? null : doctorId ? Number(doctorId) : null
    : null;
  const printHref = printDoctor
    ? `/print/commission-statement/${printDoctor}?from=${from}&to=${to}${currency ? `&currency=${currency}` : ""}${specialty ? `&specialty=${specialty}` : ""}`
    : null;
  const printBlockedReason = loading ? "يُفعَّل رابط الطباعة بعد اكتمال التحميل."
    : current?.status === "error" ? current.denied ? "لا صلاحية لطباعة الكشف." : "لا طباعة قبل تحميلٍ صحيح لهذا النطاق."
      : data && data.isPersonalOnly ? "لا أعمال لك في هذه الفترة لطباعتها."
        : "اختر طبيبًا لطباعة كشفه.";

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-3" data-commission-detail
      data-detail-state={!open ? "closed" : loading ? "loading" : current?.status ?? "loading"}>
      <button type="button" onClick={() => {
        if (!open) setOpenEpoch((value) => value + 1);
        setOpen(!open);
      }}
        className="flex w-full items-center justify-between text-sm font-extrabold text-navy-800" aria-expanded={open}>
        <span>تفصيل العمولة: مريض · عمل · نسبة</span>
        <span className="text-xs text-slate-500">{open ? "إخفاء" : "عرض"}</span>
      </button>
      {open ? (
        <div className="mt-3">
          <div className="mb-3 flex flex-wrap gap-2">
            {!personalOnly ? (
              <label className="min-w-[8rem] flex-1">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب</span>
                <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm">
                  <option value="">كل الأطباء</option>
                  {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="min-w-[8rem] flex-1">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">التخصص</span>
              <select value={specialty} onChange={(event) => setSpecialty(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm">
                <option value="">كل التخصصات</option>
                {Object.entries(CATEGORY_LABEL).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                <option value="none">بلا تخصص</option>
              </select>
            </label>
            <label className="min-w-[6rem] flex-1">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">العملة</span>
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm">
                <option value="">الكل</option>
                {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
          </div>
          {printHref ? (
            <a href={printHref} target="_blank" rel="noreferrer" data-print-link
              className="mb-3 block rounded-xl border border-navy-800 py-2 text-center text-xs font-bold text-navy-800">
              كشف الطبيب للطباعة
            </a>
          ) : (
            <p className="mb-3 rounded-xl border border-dashed border-slate-200 py-2 text-center text-[11px] text-slate-500"
              aria-disabled="true" data-print-disabled>
              كشف الطبيب للطباعة — {printBlockedReason}
            </p>
          )}
          {current?.status === "error" ? (
            <div role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
              <span>{current.message}</span>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}
                className="rounded-lg border border-red-200 bg-white px-2 py-1 font-bold text-red-700">
                إعادة المحاولة
              </button>
            </div>
          ) : null}
          {loading ? <p role="status" className="text-center text-xs text-slate-400">جارٍ تحميل التفصيل لهذا النطاق…</p> : null}
          {data ? (
            <>
              <div className="mb-2 flex flex-wrap gap-2">
                {totals.length === 0 ? <span className="text-xs text-slate-400">لا سطور في هذه الفترة.</span> : totals.map(([code, total]) => (
                  <span key={code} className="rounded-xl bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">
                    {code}: على الفواتير {formatMoney(total.accrued, code)} · المستحق {formatMoney(total.earned, code)}
                  </span>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-right text-[11px]">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="p-1.5">التاريخ</th><th className="p-1.5">المريض</th><th className="p-1.5">الفاتورة</th>
                      {!data.isPersonalOnly ? <th className="p-1.5">الطبيب</th> : null}
                      <th className="p-1.5">الخدمة</th><th className="p-1.5">التخصص / الحالة</th>
                      <th className="p-1.5">الحصة</th><th className="p-1.5">الخصومات</th>
                      <th className="p-1.5">النسبة</th><th className="p-1.5">على الفاتورة</th><th className="p-1.5">المستحق</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line, index) => (
                      <tr key={`${line.invoiceId}-${index}`} className="border-t border-slate-100 align-top">
                        <td className="p-1.5 whitespace-nowrap">{line.clinicDate}</td>
                        <td className="p-1.5">{line.patientName}{line.patientNumber ? <span className="block text-slate-400">{line.patientNumber}</span> : null}</td>
                        <td className="p-1.5 whitespace-nowrap">{line.invoiceNumber ?? `#${line.invoiceId}`}{line.visitId ? <span className="block text-slate-400">زيارة #{line.visitId}</span> : null}</td>
                        {!data.isPersonalOnly ? <td className="p-1.5">{line.doctorName}</td> : null}
                        <td className="p-1.5">{line.serviceName ?? "—"}</td>
                        <td className="p-1.5">{line.categoryLabel ?? "—"}{line.caseTitle || line.planTitle ? <span className="block text-slate-500">{line.caseTitle ? `حالة: ${line.caseTitle}` : `خطة: ${line.planTitle}`}</span> : null}</td>
                        <td className="p-1.5 whitespace-nowrap">{formatMoney(line.amountMinor, line.currency)}</td>
                        <td className="p-1.5 whitespace-nowrap">
                          {line.labDeducted ? <span className="block">مختبر {formatMoney(line.labCostMinor, line.currency)}</span> : null}
                          {line.materialDeducted ? <span className="block">مواد {formatMoney(line.materialCostMinor, line.currency)}</span> : null}
                          {!line.labDeducted && !line.materialDeducted ? "—" : null}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">{line.percent}٪<span className="block text-slate-500">{line.ruleSourceLabel}</span></td>
                        <td className="p-1.5 whitespace-nowrap">{formatMoney(line.accruedMinor, line.currency)}</td>
                        <td className="p-1.5 whitespace-nowrap font-bold text-emerald-800">
                          {formatMoney(line.earnedMinor, line.currency)}
                          <span className="block font-normal text-slate-400">
                            محصّل {formatMoney(Math.min(line.invoiceCoveredMinor, line.invoiceNetMinor), line.currency)} من {formatMoney(line.invoiceNetMinor, line.currency)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.unallocatedMaterials.length > 0 ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                  <p className="mb-1 font-bold">مواد مصروفة لم تُنسب إلى طبيب (لم تُخصم من أحد):</p>
                  <ul className="space-y-0.5">
                    {data.unallocatedMaterials.map((item) => (
                      <li key={item.movementId}>
                        {item.itemName} — {item.patientName ?? "—"} — فاتورة #{item.invoiceId} — {formatMoney(item.costMinor, base)} — {item.reasonLabel}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {data.serviceRateFindings.length > 0 ? (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-2 text-[11px] text-red-800">
                  <p className="mb-1 font-bold">نسب خدمات قديمة محفوظة بالاسم تحتاج تحديد الخدمة من إعداد الطبيب:</p>
                  <ul className="space-y-0.5">
                    {data.serviceRateFindings.map((finding, index) => (
                      <li key={index}>
                        {finding.doctorName}: «{finding.ruleName}» {finding.percent}٪ —{" "}
                        {finding.status === "ambiguous"
                          ? `يطابق ${finding.candidateServiceIds.length} خدمات بالاسم نفسه`
                          : "لا خدمة بهذا الاسم تمامًا (لا تنطبق إلا على بندٍ مكتوب بالاسم نفسه)"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
