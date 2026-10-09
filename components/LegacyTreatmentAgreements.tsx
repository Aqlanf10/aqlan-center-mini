"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { LEGACY_CASE_LABEL, LEGACY_TREATMENT_MESSAGE } from "@/lib/legacy-treatment";
import { parseLegacyVoidPreview, type LegacyVoidMode, type LegacyVoidPreview } from "@/lib/legacy-treatment-void";
import { useSession } from "./SessionProvider";
import { legacyCoverageLabel, readLegacyAgreements, type LegacyAgreementView as Agreement } from "./legacy-treatment-view";

/**
 * (INV-LEGACY) الاتفاقات التاريخية في حساب المريض — منفصلةً عن المستحق الحالي.
 * الحقيقة التاريخية (المتفق، المدفوع قبل النظام، المتبقي عند البدء، التاريخ) للقراءة؛ والمستحق الحالي هو الرصيد أعلاه
 * وحده (والمتبقي جزءٌ منه رصيدًا سابقًا). الإبطال للمدير وبسبب.
 */

const OPENING_TEXT: Record<Agreement["openingEffect"], string> = {
  none: "مسدَّد تاريخيًّا — لا رصيد سابق",
  created: "المتبقي سُجّل رصيدًا سابقًا",
  increased: "المتبقي أُضيف إلى الرصيد السابق",
};

interface Props { patientId: number; refreshKey: number; onChanged: () => void }
type ReadState =
  | { status: "loading" | "denied" | "unavailable" }
  | { status: "ready"; agreements: Agreement[]; canVoid: boolean };

type VoidPreviewState = { status: "idle" | "loading" | "unavailable" } | { status: "ready"; value: LegacyVoidPreview; sequence: number };

export function LegacyTreatmentAgreements(props: Props) {
  const session = useSession();
  const owner = JSON.stringify([props.patientId, session?.username, session?.role, session?.permissions ?? null, props.refreshKey ?? 0]);
  if (!session) return null;
  return <LegacyTreatmentAgreementsContent key={owner} {...props} />;
}

function LegacyTreatmentAgreementsContent({ patientId, refreshKey, onChanged }: Props) {
  const [read, setRead] = useState<ReadState>({ status: "loading" });
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<LegacyVoidMode>("ordinary");
  const [preview, setPreview] = useState<VoidPreviewState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lifetime = useRef({ active: false, sequence: 0, writing: false, controller: null as AbortController | null,
    previewSequence: 0, acceptedPreviewToken: null as string | null, previewController: null as AbortController | null });
  // Event closures belong to this exact read/selection generation, not merely a repeatable server fingerprint.
  const renderedReadSequence = lifetime.current.sequence;
  const renderedPreviewSequence = lifetime.current.previewSequence;

  const load = useCallback(async () => {
    const owner = lifetime.current;
    if (!owner.active) return;
    const sequence = ++owner.sequence;
    owner.controller?.abort();
    const controller = new AbortController(); owner.controller = controller;
    const current = () => owner.active && owner.sequence === sequence && !controller.signal.aborted;
    // Any re-read retires the financial preview and explicit administrative authorization.
    owner.previewSequence += 1; owner.acceptedPreviewToken = null; owner.previewController?.abort();
    setPreview({ status: "idle" }); setVoiding(null); setMode("ordinary"); setReason("");
    // Retire amounts and mutation authority before waiting on the next response.
    setRead({ status: "loading" });
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-treatments`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) {
        setRead({ status: response.status === 401 || response.status === 403 ? "denied" : "unavailable" });
        if (response.status === 401 || response.status === 403) { setVoiding(null); setReason(""); setMessage(null); }
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!current()) return;
      const parsed = readLegacyAgreements(payload, patientId);
      setRead(parsed ? { status: "ready", ...parsed } : { status: "unavailable" });
      if (parsed && !parsed.canVoid) { setVoiding(null); setReason(""); }
    } catch {
      if (current()) setRead({ status: "unavailable" });
    }
  }, [patientId]);

  useLayoutEffect(() => {
    const owner = lifetime.current; owner.active = true;
    void load();
    const refresh = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      owner.active = false; owner.sequence += 1; owner.controller?.abort();
      owner.previewSequence += 1; owner.acceptedPreviewToken = null; owner.previewController?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, refreshKey]);

  const retireVoid = () => {
    const owner = lifetime.current;
    owner.previewSequence += 1; owner.acceptedPreviewToken = null; owner.previewController?.abort();
    setVoiding(null); setReason(""); setMode("ordinary"); setPreview({ status: "idle" });
  };

  const closeVoid = () => {
    const owner = lifetime.current;
    if (!owner.active || owner.writing || owner.sequence !== renderedReadSequence
      || owner.previewSequence !== renderedPreviewSequence) return;
    retireVoid();
  };

  const loadVoidPreview = async (id: number, selectedMode: LegacyVoidMode, resetReason = false) => {
    const owner = lifetime.current;
    if (!owner.active || owner.writing || read.status !== "ready" || !read.canVoid
      || owner.sequence !== renderedReadSequence || owner.previewSequence !== renderedPreviewSequence
      || !read.agreements.some((one) => one.id === id && one.status === "live")) return;
    if (resetReason) setReason("");
    const sequence = ++owner.previewSequence;
    owner.acceptedPreviewToken = null; owner.previewController?.abort();
    const controller = new AbortController(); owner.previewController = controller;
    const current = () => owner.active && owner.previewSequence === sequence && !controller.signal.aborted;
    setVoiding(id); setMode(selectedMode); setPreview({ status: "loading" }); setMessage(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-treatments/${id}/void?mode=${selectedMode}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        setRead({ status: "denied" }); retireVoid(); return;
      }
      if (!response.ok) { setPreview({ status: "unavailable" }); return; }
      const body: unknown = await response.json().catch(() => null);
      if (!current()) return;
      const raw = body && typeof body === "object" ? (body as { preview?: unknown }).preview : null;
      const value = parseLegacyVoidPreview(raw, { patientId, agreementId: id, mode: selectedMode });
      const agreement = read.agreements.find((one) => one.id === id);
      const accepted = value && value.currency === agreement?.currency ? value : null;
      owner.acceptedPreviewToken = accepted?.previewToken ?? null;
      setPreview(accepted ? { status: "ready", value: accepted, sequence } : { status: "unavailable" });
    } catch {
      if (current()) setPreview({ status: "unavailable" });
    }
  };

  const updateVoidReason = (value: string) => {
    const owner = lifetime.current;
    if (!owner.active || owner.writing || owner.sequence !== renderedReadSequence
      || owner.previewSequence !== renderedPreviewSequence || voiding === null) return;
    setReason(value);
  };

  const submitVoid = async (id: number) => {
    const owner = lifetime.current;
    if (!owner.active || owner.writing || read.status !== "ready" || !read.canVoid || reason.trim().length < 3
      || owner.sequence !== renderedReadSequence || owner.previewSequence !== renderedPreviewSequence
      || preview.status !== "ready" || preview.sequence !== owner.previewSequence || !preview.value.canVoid || preview.value.patientId !== patientId
      || preview.value.agreementId !== id || preview.value.mode !== mode || owner.acceptedPreviewToken !== preview.value.previewToken
      || !read.agreements.some((agreement) => agreement.id === id && agreement.status === "live" && agreement.currency === preview.value.currency)) return;
    owner.writing = true; setBusy(true); setMessage(null);
    owner.sequence += 1; owner.controller?.abort();
    owner.previewSequence += 1; owner.acceptedPreviewToken = null; owner.previewController?.abort(); setRead({ status: "loading" });
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-treatments/${id}/void`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, mode, previewToken: preview.value.previewToken }),
      });
      if (!owner.active) return;
      if (response.status === 401 || response.status === 403) {
        setRead({ status: "denied" }); setVoiding(null); setReason(""); return;
      }
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!owner.active) return;
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الإبطال."); await load(); return; }
      setMessage("أُبطل الاتفاق مع بقاء هويته التاريخية. يحتاج البند مراجعة مالية قبل توقيع الزيارة؛ لا تُعد فوترته تلقائيًّا.");
      setVoiding(null); setReason(""); onChanged(); await load();
    } catch {
      if (owner.active) { setMessage("تعذّر تأكيد نتيجة الإبطال. أعد قراءة الاتفاق قبل أي محاولة أخرى."); await load(); }
    } finally {
      owner.writing = false;
      if (owner.active) setBusy(false);
    }
  };

  if (read.status !== "ready") return (
    <p role="status" data-testid="legacy-agreements-read-state" className="mb-3 text-xs text-slate-600">
      {read.status === "loading" ? "جارٍ التحقق من الاتفاقات التاريخية…"
        : read.status === "denied" ? "غير مصرّح لك بعرض الاتفاقات التاريخية."
        : "تعذّر التحقق من الاتفاقات التاريخية. لا يمكن اعتماد تغطيتها أو إبطالها الآن."}
    </p>
  );
  const { agreements, canVoid } = read;
  if (agreements.length === 0) return null;

  return (
    <section aria-label="علاجات بدأت قبل النظام" data-testid="legacy-agreements" className="mb-4">
      <h3 className="mb-1 text-sm font-bold">علاجات بدأت قبل النظام ({agreements.filter((one) => one.status === "live").length})</h3>
      <p className="mb-2 text-[11px] leading-4 text-slate-500">
        أرقامٌ تاريخية للمرجع — ليست دَينًا حاليًا ولا سندات. المستحق الحالي هو الرصيد أعلاه وحده.
      </p>
      {message ? <p role="status" className="mb-2 rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs font-bold">{message}</p> : null}
      <ul className="space-y-2">
        {agreements.map((agreement) => {
          const currency = agreement.currency;
          return (
            <li key={agreement.id} data-testid={`legacy-agreement-${agreement.id}`}
              className={`rounded-2xl border p-3 ${agreement.status === "live" ? "border-indigo-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-sm font-extrabold">
                  {agreement.serviceName}
                </span>
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-800">
                  {agreement.status === "live" ? LEGACY_CASE_LABEL : "مُبطَل · يحتاج مراجعة مالية"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {agreement.specialtyLabel}{agreement.caseTitle ? ` · ${agreement.caseTitle}` : ""} · المعلومات حتى {friendlyDateLong(agreement.historicalAsOf)}
              </p>
              {agreement.coverageState === "verified" && agreement.coverageSite ? (
                <p data-testid={`legacy-agreement-coverage-${agreement.id}`} className="mt-1 text-xs text-indigo-900">
                  التغطية المحفوظة عند التسجيل: {legacyCoverageLabel(agreement.coverageSite)}
                </p>
              ) : (
                <p role="status" data-testid={`legacy-agreement-coverage-unknown-${agreement.id}`} className="mt-1 text-xs font-bold text-amber-900">
                  {agreement.coverageState === "conflict" ? "تعارض في بيانات التغطية التاريخية." : "نطاق التغطية التاريخية غير معلوم؛ لا توجد لقطة تغطية موثوقة."}
                  {" "}يلزم التحقق قبل توقيع العمل المرتبط. السن المرجعي أو عنوان الحالة لا يثبتان نطاق الاتفاق، وتاريخ الموافقة المخزّن وحده لا يثبت موافقة حالية.
                </p>
              )}
              <dl className="mt-2 grid grid-cols-1 gap-1.5 text-center text-xs sm:grid-cols-3">
                <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-slate-500">المتفق عليه أصلًا</dt>
                  <dd className="font-extrabold">{formatMoney(agreement.agreedMinor, currency)}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-emerald-700">المدفوع قبل النظام</dt>
                  <dd className="font-extrabold text-emerald-800">{formatMoney(agreement.previouslyPaidMinor, currency)}</dd>
                </div>
                <div className="rounded-lg bg-amber-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-amber-800">المتبقي عند بدء النظام</dt>
                  <dd className="font-extrabold text-amber-900">{formatMoney(agreement.remainingMinor, currency)}</dd>
                </div>
              </dl>
              <p className="mt-1.5 text-[11px] text-slate-500">
                {agreement.status === "live" ? OPENING_TEXT[agreement.openingEffect] : "أُبطل الأثر المالي للاتفاق؛ الأرقام أعلاه محفوظة للتاريخ"} · لا سند للمدفوع سابقًا · سجّله {agreement.createdBy}
                {agreement.voidReason ? ` · سبب الإبطال: ${agreement.voidReason}` : ""}
              </p>
              <p className="mt-1.5 text-[11px] text-indigo-900">
                التقدّم السريري السابق غير معلوم من هذا الاتفاق. يلزم توثيق موافقة المريض الفعلية؛ تسجيل التاريخ المالي لا ينشئ موافقة أو جلسات سابقة.
              </p>
              {agreement.status === "void" ? <p role="status" className="mt-1 text-[11px] font-bold text-amber-900">
                تبقى هوية العلاج التاريخية. لا يُسمح بتوقيع العمل المرتبط أو إعادة فوترته قبل حسم المراجعة المالية؛ حفظ المسودة متاح.
              </p> : null}
              {canVoid && agreement.status === "live" ? (
                voiding === agreement.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="w-full text-xs text-amber-900">الإبطال يوقف التغطية ويطلب مراجعة مالية، ولا يحرّر العلاج لإعادة الفوترة. تبقى الحقيقة التاريخية محفوظة.</p>
                    <fieldset disabled={busy} className="w-full space-y-2 text-xs">
                      <legend className="mb-1 font-bold">طريقة الإبطال</legend>
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`legacy-void-mode-${agreement.id}`} checked={mode === "ordinary"}
                          onChange={() => void loadVoidPreview(agreement.id, "ordinary")} />
                        إبطال عادي: يُرفض عند وجود أي تحصيل صافٍ على الرصيد السابق بهذه العملة
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`legacy-void-mode-${agreement.id}`} checked={mode === "manager_authorized"}
                          onChange={() => void loadVoidPreview(agreement.id, "manager_authorized")} />
                        إبطال إداري صريح بعد مراجعة الأثر المالي
                      </label>
                    </fieldset>
                    {preview.status === "ready" ? (
                      <div data-testid="legacy-void-impact-preview" className="w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
                        <p className="font-bold">الأثر على إجمالي الرصيد السابق للمريض ({currency})</p>
                        <dl className="mt-2 grid grid-cols-2 gap-2">
                          <dt>أصل الرصيد قبل الإبطال</dt><dd>{formatMoney(preview.value.openingPrincipalBeforeMinor, currency)}</dd>
                          <dt>الأصل الذي سيُزال</dt><dd>{formatMoney(preview.value.removedPrincipalMinor, currency)}</dd>
                          <dt>أصل الرصيد بعد الإبطال</dt><dd>{formatMoney(preview.value.openingPrincipalAfterMinor, currency)}</dd>
                          <dt>صافي التحصيلات الحالية</dt><dd>{formatMoney(preview.value.netCollectionsMinor, currency)}</dd>
                          <dt>المستحق قبل الإبطال</dt><dd>{formatMoney(preview.value.remainingDueBeforeMinor, currency)}</dd>
                          <dt>المستحق بعد الإبطال</dt><dd>{formatMoney(preview.value.remainingDueAfterMinor, currency)}</dd>
                        </dl>
                        <p className="mt-2">التحصيلات تخص الرصيد الإجمالي؛ لا تُنسب إلى هذا الاتفاق تخمينًا. لا ردّ آلي ولا فاتورة جديدة. تبقى المراجعة المالية مطلوبة.</p>
                        {preview.value.refusal ? <p role="status" className="mt-2 font-bold text-red-800">{LEGACY_TREATMENT_MESSAGE[preview.value.refusal]}</p> : null}
                      </div>
                    ) : <p role="status" className="w-full text-xs text-amber-900">{preview.status === "loading"
                      ? "جارٍ التحقق من الأثر المالي قبل الإبطال…"
                      : "تعذّر التحقق من الأثر المالي. أعد فتح المعاينة قبل الإبطال."}</p>}
                    <input value={reason} onChange={(event) => updateVoidReason(event.target.value)} maxLength={300}
                      aria-label="سبب إبطال الاتفاق التاريخي" placeholder="سبب الإبطال"
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs" />
                    <button type="button" disabled={busy || reason.trim().length < 3 || preview.status !== "ready" || !preview.value.canVoid} onClick={() => void submitVoid(agreement.id)}
                      className="min-h-11 rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">تأكيد الإبطال</button>
                    <button type="button" disabled={busy} onClick={closeVoid}
                      className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">تراجع</button>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void loadVoidPreview(agreement.id, "ordinary", true)}
                    className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                    إبطال الاتفاق
                  </button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
