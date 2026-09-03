"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, formatMoney, isCurrency, parseAmount, type Currency } from "@/lib/money";
import { CONDITION_LABEL, isValidTooth, toothName } from "@/lib/dental";
import { visitTotal, type ProcedureLine } from "@/lib/clinical";
import { PrescriptionModal } from "./PrescriptionModal";
import {
  BILLING_RULE_LABEL, labWorkForCategory, priceForSession, sessionPriceNote,
  type BillingRule,
} from "@/lib/workflow";
import { useSetting } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { Icon } from "./Icon";
import { PHASE_LABEL, type OrthoPhase } from "@/lib/ortho";
import { ServiceSelect } from "./ServiceSelect";

const orthoPhaseLabel = (phase: string): string =>
  PHASE_LABEL[phase as OrthoPhase] ?? phase;

/**
 * «آخر شدّ قبل ٠ يومًا» جملةٌ لا يقولها إنسان.
 *
 * والطبيب يقرأ هذا السطر عشرات المرّات في اليوم، فركاكته تُقرأ في كل مرة.
 */
function sinceText(days: number | null): string {
  if (days === null) return "لا شدّات مسجّلة بعد";
  if (days <= 0) return "آخر شدّ اليوم";
  if (days === 1) return "آخر شدّ أمس";
  if (days === 2) return "آخر شدّ قبل يومين";
  if (days <= 10) return `آخر شدّ قبل ${days} أيام`;
  return `آخر شدّ قبل ${days} يومًا`;
}

/**
 * الزيارة السريرية — مساحة عمل الطبيب، والحلقة التي تُغلق الرحلة (المواصفة §١٢-٢٢).
 *
 * الطبيب يرى «مخطَّط لليوم» من بنود الخطة بأسعارها وفق قواعد الفوترة — فلا يُعاد
 * إدخال السعر ولا يُخمَّن. و«مراجعة وإنهاء الزيارة» تُظهر ما نُفّذ وما لم يُنفَّذ
 * والاستحقاق الناتج والجلسة القادمة قبل التأكيد — والتوقيع هو الذي يولّد كل شيء
 * في معاملةٍ واحدة: الفاتورة وتقدّم الجلسات والمخطط والزيارة المخطَّطة التالية.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface Doctor { id: number; name: string }
interface Visit {
  id: number; patientId: number | null; patientName: string;
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; addendum: string | null;
  doctorId: number | null; status: "open" | "signed";
  signedAt: string | null; signedBy: string | null; invoiceId: number | null;
  procedures: ProcedureLine[]; totalMinor: number;
  planItemsMatched: number; planTitle: string | null; planWarning: string | null;
  ortho: {
    caseId: number; appliance: string; phase: string; slot: string;
    upperWire: string | null; lowerWire: string | null;
    lastAdjustment: string | null; daysSinceLast: number | null;
    lastDone: string | null; elastics: string | null; elasticNote: string | null;
  } | null;
  plannedVisit: {
    id: number; title: string; sequence: number;
    planTitle: string | null; doctorId: number | null; durationMinutes: number;
  } | null;
  previousVisit: {
    id: number; date: string; treatmentDone: string | null;
    nextPlan: string | null; proceduresSummary: string | null;
  } | null;
  outstanding: {
    planItemId: number; serviceId: number | null; planTitle: string; serviceName: string;
    toothCode: number | null; billingRule: BillingRule;
    sessionCount: number; doneSessions: number; unitPriceMinor: number;
    quantity: number; status: string;
  }[];
  sessionPricing: {
    planItemId: number; procedureId: number;
    sessionIndex: number; sessionCount: number;
    priceMinor: number; note: string;
  }[];
  /** طلبات المختبر المرتبطة بالزيارة (§١٩) — للزر السياقي. */
  labOrders: {
    id: number; workType: string; toothCode: number | null;
    status: string; labName: string;
  }[];
}

/** نتيجة التوقيع — ما يحتاجه الشبّاك والملخص بعد الإنهاء. */
export interface VisitSignResult {
  invoiceId: number | null;
  duesMinor: number;
  sessionsCompleted: number;
  nextPlannedVisit: { id: number; title: string; sequence: number; durationMinutes: number } | null;
  /** طلبات مختبر تولّدت تلقائيًا من إجراءات المعمل (§١٩). */
  labOrdersCreated?: number;
  /** حركات مستهلكات خُصمت تلقائيًا (§٢٠). */
  materialsDeducted?: number;
}

interface Draft {
  serviceId: number; toothCode: string; surfaces: string; quantity: number;
  price: string; doctorId: number | null; planItemId: number | null;
}

export function ClinicalVisit({ visitId, onSigned }: {
  visitId: number;
  onSigned?: (result: VisitSignResult) => void;
}) {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const session = useSession();
  const canWrite = isAdmin(session?.role) || session?.role === "doctor";

  const [visit, setVisit] = useState<Visit | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notes, setNotes] = useState({
    chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "",
  });
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [addendum, setAddendum] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  /* الوصفة الطبية من مساحة العمل (من عمل الوكيل المساعد): التشخيص والطبيب
     يُعبّآن تلقائيًا مما كُتب في الزيارة — الطبيب يكتب التشخيص مرة واحدة. */
  const [rxOpen, setRxOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [visitResponse, serviceResponse, partyResponse] = await Promise.all([
        fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      const payload = await visitResponse.json();
      if (!visitResponse.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      const loaded = payload as Visit;
      setVisit(loaded);
      setNotes({
        chiefComplaint: loaded.chiefComplaint ?? "", examination: loaded.examination ?? "",
        diagnosis: loaded.diagnosis ?? "", treatmentDone: loaded.treatmentDone ?? "",
        nextPlan: loaded.nextPlan ?? "",
      });
      setDoctorId(loaded.doctorId);
      setDrafts(loaded.procedures.map((line) => ({
        serviceId: line.serviceId, toothCode: line.toothCode ? String(line.toothCode) : "",
        surfaces: line.surfaces ?? "", quantity: line.quantity,
        price: formatAmount(line.unitPriceMinor, base), doctorId: line.doctorId,
        planItemId: line.planItemId,
      })));
      if (serviceResponse.ok) setServices(await serviceResponse.json());
      if (partyResponse.ok) {
        const parties = await partyResponse.json();
        setDoctors(Array.isArray(parties) ? parties : parties.balances ?? []);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    }
  }, [visitId, base]);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (body: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, visitId, load]);

  /** التوقيع — يستجاب بنتيجة الرحلة كاملة فيمرّرها للشبّاك. */
  const sign = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sign" }),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.message ?? "تعذّر التوقيع."); return; }
      setReviewOpen(false);
      await load();
      onSigned?.({
        invoiceId: payload.invoiceId ?? null,
        duesMinor: payload.duesMinor ?? 0,
        sessionsCompleted: payload.sessionsCompleted ?? 0,
        nextPlannedVisit: payload.nextPlannedVisit ?? null,
        labOrdersCreated: payload.labOrdersCreated ?? 0,
        materialsDeducted: payload.materialsDeducted ?? 0,
      });
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, visitId, load, onSigned]);

  /*
   * الطلب السياقي للمختبر (§١٩): إجراء التاج أو الجسر أو القشرة يولّد زرّه —
   * «🦷 طلب معمل» ببياناتٍ مسبقة (المريض والسنّ ونوع العمل والزيارة) — بلا نموذج.
   * والطلب الموجود للسنّ نفسه يُظهر حالته بدل الزر: الموجود لا يُطلب مرّتين.
   */
  const createLabRequest = async (draft: Draft, index: number) => {
    if (!visit || busy) return;
    const service = services.find((row) => row.id === draft.serviceId);
    const workType = labWorkForCategory(service?.category ?? null);
    if (!workType || !visit.patientId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/lab", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: visit.patientId,
          status: "needed",
          visitId: visit.id,
          toothCode: draft.toothCode ? Number(draft.toothCode) : null,
          workType,
          details: `من ${service?.name ?? workType}${draft.toothCode ? ` — سن ${draft.toothCode}` : ""}`,
          note: "طلب من شاشة الزيارة — أكمل بيانات المختبر ثم أرسله",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر إنشاء طلب المختبر.");
        return;
      }
      void index;
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  /** طلب المختبر الموجود لهذا السنّ في هذه الزيارة — لعرضه بدل الزر. */
  const labForDraft = (draft: Draft) => {
    if (!visit) return null;
    const tooth = draft.toothCode ? Number(draft.toothCode) : null;
    return (
      visit.labOrders.find((order) => order.toothCode === tooth && tooth !== null) ??
      visit.labOrders.find((order) => order.toothCode === null) ?? null
    );
  };

  if (!visit) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
      {error ?? "جارٍ التحميل…"}
    </p>;
  }

  const signed = visit.status === "signed";
  const lines = drafts.map((draft) => ({
    quantity: draft.quantity,
    unitPriceMinor: parseAmount(draft.price, base) ?? 0,
  }));
  const total = visitTotal(lines);

  const payload = () => ({
    ...notes, doctorId,
    procedures: drafts.map((draft) => ({
      serviceId: draft.serviceId,
      toothCode: draft.toothCode ? Number(draft.toothCode) : null,
      surfaces: draft.surfaces || null,
      quantity: draft.quantity,
      unitPriceMinor: parseAmount(draft.price, base) ?? 0,
      doctorId: draft.doctorId,
      planItemId: draft.planItemId,
    })),
  });

  /*
   * «مخطَّط لليوم» — بنود الخطة التي لم تكتمل، مع سعر جلستها القادمة وفق قاعدة
   * الفوترة. الإضافة منها تربط الإجراء ببنده فيملك الخادمُ السعر، وتُنجَز الجلسة
   * عند التوقيع فيتقدّم البند من نفسه (المواصفة §١٣).
   */
  const addedItemIds = new Set(drafts.map((draft) => draft.planItemId).filter((id): id is number => id !== null));
  const plannedToday = visit.outstanding.filter((item) => !addedItemIds.has(item.planItemId));
  const doneToday = drafts.filter((draft) => draft.planItemId !== null);
  const notDoneToday = visit.outstanding.filter((item) => !addedItemIds.has(item.planItemId));

  const addPlannedItem = (item: Visit["outstanding"][number]) => {
    // سعر الجلسة القادمة وفق قاعدة البند — نفس دالة الخادم، فيتطابق الرقمان.
    const lineTotal = item.unitPriceMinor * item.quantity;
    const sessionIndex = item.doneSessions + 1;
    const suggested = priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
    setDrafts((rows) => [
      ...rows,
      {
        serviceId: item.serviceId ?? 0,
        toothCode: item.toothCode ? String(item.toothCode) : "",
        surfaces: "",
        quantity: 1,
        price: formatAmount(suggested, base),
        doctorId,
        planItemId: item.planItemId,
      },
    ]);
  };

  /* ملاحظة جلسةٍ لسطرٍ مرتبط ببند — تُحسب هنا من بيانات البند نفسها بنفس دوال
   * الخادم، فتظهر للطبيب على الشاشة الجملة التي سيحكم بها الخادم عند التوقيع. */
  const sessionNoteForDraft = (draft: Draft, index: number): string | null => {
    if (draft.planItemId === null || !visit) return null;
    const item = visit.outstanding.find((row) => row.planItemId === draft.planItemId);
    if (!item) return null;
    const occurrencesBefore = drafts
      .slice(0, index)
      .filter((row) => row.planItemId === draft.planItemId).length;
    const sessionIndex = item.doneSessions + occurrencesBefore + 1;
    return sessionPriceNote(item.billingRule, sessionIndex, item.sessionCount);
  };

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

      <div className={`mb-4 flex flex-wrap items-center gap-2 rounded-2xl border-2 p-3 ${
        signed ? "border-success-300 bg-success-50" : "border-navy-800 bg-white"
      }`}>
        <Icon name={signed ? "check" : "clock"} className={`h-5 w-5 ${signed ? "text-success-700" : "text-navy-800"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-navy-900">
            {signed ? "زيارة موقَّعة" : "زيارة مفتوحة"} — {visit.patientName}
          </p>
          {signed ? (
            <p className="text-[11px] font-semibold text-slate-500">
              وقّعها {visit.signedBy} · {visit.signedAt?.slice(0, 10)}
              {visit.invoiceId ? ` · فاتورة #${visit.invoiceId}` : " · بلا فاتورة (كشف)"}
            </p>
          ) : null}
        </div>
        {signed && visit.invoiceId ? (
          <a href={`/print/invoice/${visit.invoiceId}`} target="_blank" rel="noopener"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
            الفاتورة
          </a>
        ) : null}
        {/* وصفة طبية من مساحة العمل — بلا الرجوع لرأس ملف المريض. */}
        {visit.patientId ? (
          <button
            type="button"
            onClick={() => setRxOpen(true)}
            className="flex items-center gap-1 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 transition-colors"
          >
            <span>💊</span>
            <span>روشتة طبية (℞)</span>
          </button>
        ) : null}
      </div>

      {/*
        * سياق الرحلة قبل الحقول: الزيارة المخطَّطة التي جاءت منها هذه الزيارة،
        * وآخر زيارة قبلها — ما عُمل آخر مرة يُقرأ لا يُخمَّن (المواصفة §١٢).
        */}
      {visit.plannedVisit ? (
        <div className="mb-3 rounded-xl border border-navy-200 bg-navy-50 px-3 py-2">
          <p className="text-xs font-extrabold text-navy-900">
            مخطَّط لهذه الزيارة: {visit.plannedVisit.title}
            {visit.plannedVisit.planTitle ? ` · ${visit.plannedVisit.planTitle}` : ""}
          </p>
          <p className="text-[11px] text-navy-800">
            زيارة {visit.plannedVisit.sequence} · مدة مقترحة {visit.plannedVisit.durationMinutes} دقيقة
          </p>
        </div>
      ) : null}

      {!signed && visit.previousVisit ? (
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-extrabold text-slate-700">
            آخر زيارة ({visit.previousVisit.date}):
          </p>
          <p className="text-[11px] text-slate-600">
            {visit.previousVisit.proceduresSummary ?? visit.previousVisit.treatmentDone ?? "كشف"}
            {visit.previousVisit.nextPlan ? ` · الخطة حينها: ${visit.previousVisit.nextPlan}` : ""}
          </p>
        </div>
      ) : null}

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <Field label="الشكوى الرئيسية" value={notes.chiefComplaint} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, chiefComplaint: value }))} />
        <Field label="الفحص" value={notes.examination} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, examination: value }))} />
        <Field label="التشخيص" value={notes.diagnosis} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, diagnosis: value }))} />
        <Field label="ما نُفّذ" value={notes.treatmentDone} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, treatmentDone: value }))} />
        <Field label="الخطة القادمة" value={notes.nextPlan} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, nextPlan: value }))} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المعالج</span>
          <select value={doctorId ?? ""} disabled={signed}
            onChange={(event) => setDoctorId(Number(event.target.value) || null)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

      {/* مخطَّط لليوم — من بنود الخطة، بأسعار جلساتها من الخطة */}
      {!signed && plannedToday.length > 0 ? (
        <section className="mb-4 rounded-2xl border border-navy-200 bg-navy-50/40 p-3" aria-label="مخطَّط لليوم">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            مخطَّط لهذا المريض — من خطط علاجه
          </h3>
          <ul className="space-y-1.5">
            {plannedToday.map((item) => {
              const sessionIndex = item.doneSessions + 1;
              const lineTotal = item.unitPriceMinor * item.quantity;
              const price = priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
              return (
                <li key={item.planItemId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-navy-900">
                      {item.serviceName}
                      {item.toothCode ? <span className="rounded-lg bg-navy-50 px-1.5 py-0.5 mr-1.5 text-[10px] font-bold text-navy-800">سن {item.toothCode}</span> : null}
                      {item.sessionCount > 1 ? (
                        <span className="text-[10px] font-normal text-slate-500">
                          {" "}· جلسة {sessionIndex} من {item.sessionCount}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {BILLING_RULE_LABEL[item.billingRule]}
                      {price === 0 ? " — تُسعَّر هذه الجلسة وفق قاعدة البند" : ""}
                      {" · من «"}{item.planTitle}{"»"}
                    </p>
                  </div>
                  <button type="button" onClick={() => addPlannedItem(item)}
                    className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-[11px] font-extrabold text-navy-800 hover:bg-navy-50">
                    + نفّذ اليوم
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
            سعر الجلسة يأتي من الخطة وفق قاعدة فوترة البند — عند البدء أو الإكمال أو
            لكل جلسة — ولا يُكتب من الشاشة.
          </p>
        </section>
      ) : null}

      <section className="mb-4" aria-label="الإجراءات المنفَّذة">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-navy-900">الإجراءات المنفَّذة</h3>
          <span className="text-sm font-extrabold text-navy-900">{formatMoney(total, base)}</span>
        </div>

        {drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs font-semibold text-slate-400">
            لا إجراءات. الزيارة بلا إجراء تُوقَّع كشفًا بلا فاتورة.
          </p>
        ) : (
          <ul className="space-y-2">
            {drafts.map((draft, index) => {
              const service = services.find((row) => row.id === draft.serviceId);
              const note = sessionNoteForDraft(draft, index);
              return (
                <li key={index} className={`rounded-xl border p-3 ${
                  draft.planItemId ? "border-navy-200 bg-navy-50/30" : "border-slate-200 bg-white"
                }`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-navy-900">{service?.name ?? "خدمة"}</span>
                    {draft.toothCode ? (
                      <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[11px] font-bold text-navy-800">
                        {toothName(Number(draft.toothCode))}
                      </span>
                    ) : null}
                    {draft.planItemId ? (
                      <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-[10px] font-extrabold text-emerald-800">
                        من الخطة — سعرها من قاعدة البند
                      </span>
                    ) : null}
                    {note ? (
                      <span className="text-[10px] text-slate-500">{note}</span>
                    ) : null}
                    {labWorkForCategory(services.find((row) => row.id === draft.serviceId)?.category ?? null) ? (
                      // الزر السياقي (§١٩ و§٢٧): يظهر عند إجراء المعمل فقط.
                      (() => {
                        const existing = labForDraft(draft);
                        return existing ? (
                          <a href="/lab" className="rounded-lg bg-sky-100 px-2 py-1 text-[10px] font-extrabold text-sky-800 no-underline hover:bg-sky-200">
                            🦷 طلب معمل: {existing.workType}
                            {existing.status === "needed" ? " — لم يُرسل بعد" : ""}
                          </a>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void createLabRequest(draft, index)}
                            disabled={busy || !visit.patientId}
                            title="طلب مختبر مسبق البيانات من هذا الإجراء — المريض والسنّ والنوع"
                            className="rounded-lg bg-sky-600 px-2 py-1 text-[10px] font-extrabold text-white hover:bg-sky-700 disabled:opacity-40"
                          >
                            🦷 طلب معمل
                          </button>
                        );
                      })()
                    ) : null}
                    {!signed ? (
                      <button onClick={() => setDrafts((rows) => rows.filter((_, i) => i !== index))}
                        className="mr-auto rounded-lg px-2 py-1 text-[11px] font-bold text-danger-700 hover:bg-danger-50">
                        احذف
                      </button>
                    ) : (
                      <span className="mr-auto text-sm font-bold text-navy-900">
                        {formatMoney(draft.quantity * (parseAmount(draft.price, base) ?? 0), base)}
                      </span>
                    )}
                  </div>
                  {!signed ? (
                    <div className="flex flex-wrap gap-2">
                      <input value={draft.toothCode} inputMode="numeric" dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, toothCode: event.target.value } : row))}
                        placeholder="رقم السن" aria-label="رقم السن"
                        className={`w-24 rounded-xl border px-3 py-2 text-sm ${
                          draft.toothCode && !isValidTooth(Number(draft.toothCode))
                            ? "border-danger-300 bg-danger-50" : "border-slate-200"
                        }`} />
                      <input value={draft.surfaces} dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, surfaces: event.target.value } : row))}
                        placeholder="الأسطح" aria-label="الأسطح"
                        className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.quantity} type="number" min={1} dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, quantity: Math.max(1, Number(event.target.value) || 1) } : row))}
                        aria-label="الكمية"
                        className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.price} inputMode="decimal" dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, price: event.target.value } : row))}
                        aria-label="السعر"
                        disabled={draft.planItemId !== null}
                        title={draft.planItemId !== null ? "سعر إجراء الخطة يُحسب من الخطة وفق قاعدة الفوترة" : undefined}
                        className="min-w-[6rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold disabled:bg-slate-50 disabled:text-slate-500" />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {!signed && canWrite ? (
          <div className="mt-3 rounded-2xl border border-dashed border-navy-300 bg-navy-50/50 p-3 space-y-2">
            <span className="block text-xs font-extrabold text-navy-900">+ إجراء غير مخطَّط — من الدليل</span>
            <ServiceSelect
              services={services}
              value={null}
              onChange={(id, service) => {
                if (!service) return;
                setDrafts((rows) => [
                  ...rows,
                  {
                    serviceId: service.id,
                    toothCode: "",
                    surfaces: "",
                    quantity: 1,
                    price: formatAmount(service.priceMinor, base),
                    doctorId,
                    planItemId: null,
                  },
                ]);
              }}
              base={base}
              placeholder="+ انقر لاختيار إجراء من الدليل المصنف…"
              ariaLabel="أضف إجراءً"
            />
          </div>
        ) : null}
      </section>

      {signed ? (
        <section aria-label="الملاحق">
          {visit.addendum ? (
            <pre className="mb-3 whitespace-pre-wrap rounded-xl border border-warning-300 bg-warning-50 p-3 text-[11px] font-semibold leading-5 text-warning-900">
              {visit.addendum}
            </pre>
          ) : null}
          {canWrite ? (
            <>
              <textarea value={addendum} onChange={(event) => setAddendum(event.target.value)}
                rows={2} placeholder="ملحق تصحيحي — يُضاف ولا يمحو ما قبله"
                aria-label="ملحق"
                className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
              <button
                onClick={async () => {
                  if (await send({ action: "addendum", text: addendum })) setAddendum("");
                }}
                disabled={busy || !addendum.trim()}
                className="rounded-xl border border-warning-300 bg-warning-50 px-4 py-2 text-sm font-bold text-warning-900 disabled:opacity-40">
                أضف ملحقًا
              </button>
            </>
          ) : null}
        </section>
      ) : canWrite ? (
        <>
          {visit.patientId === null ? (
            <LinkPatient visitId={visit.id} suggestion={visit.patientName} onLinked={() => void load()} />
          ) : null}

          {visit.ortho ? (
            <div className="mb-2 rounded-xl border border-navy-200 bg-navy-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-extrabold text-navy-900">
                  مريض تقويم · {orthoPhaseLabel(visit.ortho.phase)}
                </span>
                {/* السلكان موسومان: «014 / 012» وحدها لا تقول أيّهما العلوي. */}
                <span className="flex items-center gap-2 text-sm font-extrabold text-navy-900">
                  {visit.ortho.upperWire || visit.ortho.lowerWire ? (
                    <>
                      <span>علوي <span dir="ltr">{visit.ortho.upperWire ?? "—"}</span></span>
                      <span className="text-navy-300">·</span>
                      <span>سفلي <span dir="ltr">{visit.ortho.lowerWire ?? "—"}</span></span>
                    </>
                  ) : "بلا سلك بعد"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-navy-800">
                {visit.ortho.lastAdjustment
                  ? `${sinceText(visit.ortho.daysSinceLast)}${visit.ortho.lastDone ? ` — ${visit.ortho.lastDone}` : ""}`
                  : "لا شدّات مسجّلة بعد"}
                {visit.ortho.elasticNote ? ` · مطاطات: ${visit.ortho.elasticNote}` : ""}
              </p>
              <a href={`/patients/${visit.patientId}?tab=ortho`}
                className="mt-1 inline-block text-[11px] font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">
                افتح ملف التقويم لتسجيل الشدّة
              </a>
            </div>
          ) : null}

          {visit.planWarning ? (
            <p role="alert" className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
              {visit.planWarning}
            </p>
          ) : visit.planItemsMatched > 0 ? (
            <p className="mb-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-800">
              يشطب هذا العمل {visit.planItemsMatched} من بنود
              {visit.planTitle ? ` «${visit.planTitle}»` : " خطة العلاج"}.
            </p>
          ) : null}

        <div className="flex flex-wrap gap-2">
          <button onClick={() => void send(payload())} disabled={busy}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-navy-800 disabled:opacity-40">
            احفظ بلا توقيع
          </button>
          <button
            onClick={async () => {
              // الحفظ ثم المراجعة: توقيعٌ يترك ما كُتب في الشاشة غير محفوظ يفقد العمل.
              if (await send(payload())) {
                setReviewOpen(true);
              }
            }}
            disabled={busy}
            className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            مراجعة وإنهاء الزيارة
          </button>
        </div>
        </>
      ) : (
        <p className="text-[11px] font-semibold text-slate-400">التوثيق السريري يُكتب من الطبيب.</p>
      )}

      {!signed && canWrite ? (
        <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-400">
          الإنهاء يوقّع الزيارة فيولّد الفاتورة بأسعار الخطة، وينجز الجلسات، ويحدّث
          المخطط السني، ويقترح الجلسة القادمة — كلها في عملية واحدة. وبعده لا تُعدَّل
          الزيارة — التصحيح بملحق يحمل كاتبه ووقته.
        </p>
      ) : null}

      {/* شاشة المراجعة والإنهاء (المواصفة §٢١): ما نُفّذ، وما لم يُنفّذ، والاستحقاق،
          والجلسة القادمة — ثم تأكيدٌ واحد لا يفاجئ أحدًا برقم. */}
      {reviewOpen ? (
        <div role="dialog" aria-label="مراجعة وإنهاء الزيارة"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setReviewOpen(false)}>
          <section className="w-full max-w-lg rounded-2xl border border-navy-800 bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}>
            <header className="mb-3">
              <h3 className="text-sm font-extrabold text-navy-900">مراجعة وإنهاء الزيارة</h3>
              <p className="text-[11px] text-slate-500">{visit.patientName}</p>
            </header>

            <dl className="space-y-2 text-xs">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <dt className="mb-1 font-extrabold text-emerald-900">تم اليوم</dt>
                {doneToday.length > 0 ? (
                  <dd className="space-y-0.5">
                    {doneToday.map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, base) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex justify-between gap-2 text-emerald-900">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""}</span>
                          <span className="font-bold">{formatMoney(amount, base)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : (
                  <dd className="text-slate-500">لا إجراءات من الخطة — ما يلي إجراءاتٌ حرّة.</dd>
                )}
                {drafts.length > doneToday.length ? (
                  <dd className="mt-1 space-y-0.5">
                    {drafts.filter((draft) => draft.planItemId === null).map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, base) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex justify-between gap-2 text-slate-700">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""} (غير مخطَّط)</span>
                          <span className="font-bold">{formatMoney(amount, base)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : null}
              </div>

              {notDoneToday.length > 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <dt className="mb-1 font-extrabold text-slate-700">لم يُنفّذ بعد</dt>
                  <dd className="space-y-0.5 text-slate-600">
                    {notDoneToday.slice(0, 6).map((item) => (
                      <p key={item.planItemId}>
                        {item.serviceName}{item.toothCode ? ` — سن ${item.toothCode}` : ""}
                        {item.sessionCount > 1 ? ` (جلسة ${item.doneSessions + 1} من ${item.sessionCount})` : ""}
                      </p>
                    ))}
                    {notDoneToday.length > 6 ? <p>و{notDoneToday.length - 6} أخرى…</p> : null}
                  </dd>
                </div>
              ) : null}

              <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-3">
                <dt className="font-extrabold text-amber-900">الاستحقاق المالي الناتج</dt>
                <dd className="text-lg font-black text-amber-900">{formatMoney(total, base)}</dd>
              </div>

              <div className="rounded-xl border border-navy-200 bg-navy-50 p-3">
                <dt className="font-extrabold text-navy-900">خطة الزيارة القادمة</dt>
                <dd className="mt-0.5 text-navy-800">
                  {notes.nextPlan?.trim()
                    ? notes.nextPlan
                    : notDoneToday[0]
                      ? `${notDoneToday[0].serviceName}${notDoneToday[0].toothCode ? ` — سن ${notDoneToday[0].toothCode}` : ""}${notDoneToday[0].sessionCount > 1 ? ` (جلسة ${notDoneToday[0].doneSessions + 1} من ${notDoneToday[0].sessionCount})` : ""}`
                      : "تُقترح تلقائيًا من الجلسات المتبقّية عند الإنهاء"}
                  {notDoneToday[0] ? ` · مدة مقترحة 30 دقيقة` : ""}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => setReviewOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600">
                رجوع — أكمل العمل
              </button>
              <button type="button" onClick={() => void sign()} disabled={busy}
                className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
                {busy ? "جارٍ الإنهاء…" : `تأكيد إنهاء الزيارة${total > 0 ? ` — ${formatMoney(total, base)}` : ""}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* وصفة طبية من مساحة العمل (من عمل الوكيل المساعد): التشخيص المكتوب
          والطبيب المختار يُعبّآن تلقائيًا — وصفةٌ من سياق الزيارة نفسها. */}
      <PrescriptionModal
        isOpen={rxOpen}
        onClose={() => setRxOpen(false)}
        patientId={visit?.patientId ?? undefined}
        patientName={visit?.patientName ?? ""}
        defaultDiagnosis={notes.diagnosis}
        defaultDoctorName={doctors.find((d) => d.id === doctorId)?.name ?? ""}
      />
    </div>
  );
}

function Field({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-slate-500">{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} disabled={disabled}
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue disabled:bg-slate-50 disabled:text-slate-500" />
    </label>
  );
}

/**
 * يربط زيارةً بملفٍّ قائم قبل التوقيع.
 *
 * لا مطابقة صامتة بالاسم: «محمد أحمد» اسمُ رجلين، ودمجُ ملفَّي شخصين يخلط تاريخين
 * طبيّين — وهو أسوأ من تكرار ملفٍّ واحد يُدمج لاحقًا. فالبرنامج يعرض، والطبيب يقرّر.
 */
function LinkPatient({ visitId, suggestion, onLinked }: {
  visitId: number; suggestion: string; onLinked: () => void;
}) {
  const [term, setTerm] = useState(suggestion);
  const [matches, setMatches] = useState<{ id: number; patientNumber: string; fullName: string; phone: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const text = term.trim();
    if (text.length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/patients?q=${encodeURIComponent(text)}`, { cache: "no-store" });
          if (!response.ok) return;
          const payload = await response.json();
          setMatches(Array.isArray(payload) ? payload.slice(0, 5) : []);
        } catch {
          // البحث مساعدةٌ لا شرط — تعذّره لا يمنع التوقيع.
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [term, open]);

  const link = async (patientId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link", patientId }),
      });
      if (response.ok) { setOpen(false); onLinked(); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
      <p className="text-xs font-bold text-amber-900">
        هذه الزيارة غير مربوطة بملف — والتوقيع سيُنشئ ملفًّا جديدًا.
        {open ? "" : " إن كان المريض مسجّلًا فاربطه بملفّه."}
        {open ? null : (
          <button type="button" onClick={() => setOpen(true)}
            className="mr-2 rounded-lg border border-amber-400 bg-white px-2 py-0.5 font-bold text-amber-800">
            ابحث عن ملفّه
          </button>
        )}
      </p>

      {open ? (
        <div className="mt-2">
          <input value={term} onChange={(event) => setTerm(event.target.value)}
            aria-label="ابحث عن ملف المريض" autoFocus
            className="mb-1.5 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs" />
          {matches.length === 0 ? (
            <p className="text-[11px] text-amber-800">لا ملفّات مطابقة — سيُنشأ له ملفٌ جديد عند التوقيع.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {matches.map((match) => (
                <li key={match.id}>
                  <button type="button" disabled={busy} onClick={() => void link(match.id)}
                    className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-bold text-navy-800 disabled:opacity-40">
                    {match.fullName}
                    <span className="mr-1.5 font-normal text-slate-500">
                      {match.patientNumber}{match.phone ? ` · ${match.phone}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
