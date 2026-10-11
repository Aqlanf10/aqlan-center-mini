"use client";
import { useLayoutEffect, useRef } from "react";
import type { RetentionRead } from "@/lib/ortho-retention-client";
import { RETENTION_EVENT_KINDS, RETENTION_REVIEW_FINDINGS, chooseRetentionDevice, chooseRetentionKind, type RetentionEditorDraft } from "@/lib/ortho-retention-editor";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
export const RETENTION_EVENT_LABELS = { debond: "فك الجهاز التقويمي", device_delivery: "تسليم جهاز تثبيت مستقل", device_replacement: "استبدال جهاز تثبيت فعلي",
  device_review: "مراجعة جهاز محدد", device_repair: "إصلاح جهاز محدد", device_status_change: "توثيق حالة جهاز محدد", followup_intent: "نية متابعة غير محجوزة" } as const;
const findings = { fit: "الملاءمة", breakage: "الكسر", loss: "الفقد", hygiene: "النظافة", adherence: "الالتزام", relapse: "الانتكاس" } as const;
const arches = { upper: "الفك العلوي", lower: "الفك السفلي", legacy_unknown: "فك غير معلوم في السجل التاريخي" } as const;
const control = "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100 disabled:opacity-70";
export interface RetentionDraftEdit { ownerKey: string; expectedDraft: string; draft: RetentionEditorDraft }
/** Controlled fields only. Parent owns exact scope, durable command identity and transport. */
export function OrthoRetentionEventEditor(props: { ownerKey: string; draft: RetentionEditorDraft; read: RetentionRead; writable: boolean; documentReferencesManaged?: boolean;
  isCurrent(): boolean; onChange(request: RetentionDraftEdit): boolean }) {
  const { draft, read } = props, committed = useRef<object | null>(null), snapshot = {};
  const renderedBytes = canonicalJourneyJSON(draft);
  useLayoutEffect(() => { committed.current = snapshot; return () => { if (committed.current === snapshot) committed.current = null; }; }, [snapshot]);
  const current = () => committed.current === snapshot && props.writable && props.isCurrent();
  const edit = (value: RetentionEditorDraft) => current() && props.onChange({ ownerKey: props.ownerKey, expectedDraft: renderedBytes, draft: value });
  const update = <K extends keyof RetentionEditorDraft>(key: K, value: RetentionEditorDraft[K]) => edit({ ...draft, [key]: value });
  const deviceKind = ["device_replacement", "device_review", "device_repair", "device_status_change", "followup_intent"].includes(draft.kind);
  const deviceOptions = read.devices.filter(device => draft.kind !== "device_replacement" || draft.supersedesEntryId !== null
    || !read.devices.some(replacement => replacement.replacedDeviceId === device.deviceId));
  return <fieldset disabled={!props.writable} dir="rtl" className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-4" aria-label="حقول توثيق جهاز التثبيت">
    {draft.supersedesEntryId !== null ? <p className="text-sm text-amber-900">تصحيح صريح للسجل #{draft.supersedesEntryId}. السجل السابق يبقى محفوظًا؛ التصحيح لا ينشئ جهازًا فعليًا جديدًا.</p> : null}
    <label className="block text-sm font-semibold">نوع التدوين<select aria-label="نوع تدوين التثبيت" className={control} value={draft.kind} disabled={!props.writable || draft.supersedesEntryId !== null}
      onChange={event => { const kind = event.currentTarget.value as RetentionEditorDraft["kind"]; if (kind === "" || RETENTION_EVENT_KINDS.some(value => value === kind)) edit(chooseRetentionKind(draft, kind)); }}>
      <option value="">اختر نوع التدوين صراحةً</option>{RETENTION_EVENT_KINDS.map(kind => <option key={kind} value={kind}>{RETENTION_EVENT_LABELS[kind]}</option>)}
    </select></label>
    {deviceKind ? <label className="block text-sm font-semibold">الجهاز الفعلي<select aria-label="الجهاز الفعلي للتدوين" className={control}
      value={draft.device?.deviceId ?? ""} disabled={!props.writable || draft.supersedesEntryId !== null}
      onChange={event => { const value = event.currentTarget.value; const device = value === "" ? null : deviceOptions.find(row => String(row.deviceId) === value);
        if (device !== undefined) edit(chooseRetentionDevice(draft, device)); }}>
      <option value="">{draft.kind === "followup_intent" ? "متابعة عامة دون جهاز محدد" : "اختر الجهاز بمعرّفه"}</option>
      {deviceOptions.map(device => <option key={device.deviceId} value={device.deviceId}>#{device.deviceId} · {arches[device.arch]} · {device.delivery.description} · آخر سجل #{device.lastEventId}</option>)}
    </select></label> : null}
    {draft.device ? <p className="text-xs text-slate-600">الجهاز #{draft.device.deviceId}، مرجع حالته الملتقط #{draft.device.expectedDeviceRevisionId}. تغيّر السجل لاحقًا لا يحدّث هذا الاختيار تلقائيًا.</p> : null}
    <label className="block text-sm font-semibold">الفك<select aria-label="فك تدوين التثبيت" className={control} value={draft.arch}
      onChange={event => { const arch = event.currentTarget.value as RetentionEditorDraft["arch"]; if (arch === "" || Object.hasOwn(arches, arch)) update("arch", arch); }}>
      <option value="">اختر الفك</option>{Object.entries(arches).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {draft.supersedesEntryId !== null && draft.arch !== draft.originalArch ? <label className="block text-sm">سبب تصحيح الفك<textarea aria-label="سبب تصحيح فك الجهاز" className={control} maxLength={500}
      value={draft.archCorrectionReason} onChange={event => update("archCorrectionReason", event.currentTarget.value)} /></label> : null}
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="text-sm">دليل التاريخ<select aria-label="مصدر تاريخ التثبيت" className={control} value={draft.occurrence.dateProvenance}
        onChange={event => { const value = event.currentTarget.value as RetentionEditorDraft["occurrence"]["dateProvenance"];
          if (["unknown", "contemporaneous_record", "retrospective_record", "historical_source"].includes(value)) update("occurrence", { ...draft.occurrence, dateProvenance: value, occurredOn: value === "unknown" ? null : draft.occurrence.occurredOn }); }}>
        <option value="unknown">التاريخ غير معلوم</option><option value="contemporaneous_record">تدوين وقت الحدث</option><option value="retrospective_record">تدوين استعادي صريح</option><option value="historical_source">مصدر تاريخي</option>
      </select></label>
      {draft.occurrence.dateProvenance !== "unknown" ? <label className="text-sm">التاريخ السريري<input aria-label="تاريخ حدث التثبيت" type="date" className={control} value={draft.occurrence.occurredOn ?? ""}
        onChange={event => update("occurrence", { ...draft.occurrence, occurredOn: event.currentTarget.value || null })} /></label>
        : <p className="self-center text-xs text-slate-600">لا يُستبدل التاريخ المجهول بتاريخ اليوم أو وقت إدخال السجل.</p>}
    </div>
    <label className="block text-sm">توضيح مصدر التاريخ<textarea aria-label="توضيح مصدر تاريخ التثبيت" className={control} maxLength={1000} value={draft.occurrence.sourceNote}
      onChange={event => update("occurrence", { ...draft.occurrence, sourceNote: event.currentTarget.value })} /></label>
    {draft.kind === "device_delivery" || draft.kind === "device_replacement" ? <>
      <label className="block text-sm">نوع جهاز التثبيت<select aria-label="نوع جهاز التثبيت" className={control} value={draft.deviceType}
        onChange={event => { const value = event.currentTarget.value as RetentionEditorDraft["deviceType"]; if (["", "fixed", "removable", "other"].includes(value)) update("deviceType", value); }}>
        <option value="">اختر النوع</option><option value="fixed">ثابت</option><option value="removable">متحرك</option><option value="other">نوع آخر موصوف</option>
      </select></label>
      <label className="block text-sm">وصف الجهاز<input aria-label="وصف جهاز التثبيت" className={control} maxLength={1000} value={draft.description} onChange={event => update("description", event.currentTarget.value)} /></label>
      <p className="text-xs text-slate-600">أمر المختبر غير مربوط في هذا الإصدار. توثيق التسليم لا ينشئ طلب مختبر أو مبلغًا.</p>
    </> : null}
    {["debond", "device_delivery", "device_replacement"].includes(draft.kind) ? <label className="block text-sm">الأسنان أو امتداد الجهاز كما سُجل<input aria-label="امتداد حدث التثبيت" className={control} maxLength={500}
      value={draft.extent} onChange={event => update("extent", event.currentTarget.value)} /></label> : null}
    {draft.kind === "device_repair" ? <label className="block text-sm">وصف الإصلاح<textarea aria-label="وصف إصلاح جهاز التثبيت" className={control} maxLength={4000} value={draft.description}
      onChange={event => update("description", event.currentTarget.value)} /></label> : null}
    {draft.kind === "device_review" ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">{RETENTION_REVIEW_FINDINGS.map(key => <div key={key} className="min-w-0 rounded-lg border border-slate-200 p-3">
      <label className="block text-sm">{findings[key]}<select aria-label={`حالة ${findings[key]}`} className={control} value={draft.findings[key].state}
        onChange={event => { const value = event.currentTarget.value as RetentionEditorDraft["findings"][typeof key]["state"]; if (["not_assessed", "unknown", "recorded"].includes(value)) update("findings", { ...draft.findings, [key]: { ...draft.findings[key], state: value } }); }}>
        <option value="not_assessed">لم يُقيّم</option><option value="unknown">غير معلوم بحسب التدوين</option><option value="recorded">نتيجة موصوفة</option>
      </select></label><label className="block text-sm">الوصف<textarea aria-label={`وصف ${findings[key]}`} className={control} maxLength={1000} value={draft.findings[key].note}
        onChange={event => update("findings", { ...draft.findings, [key]: { ...draft.findings[key], note: event.currentTarget.value } })} /></label>
    </div>)}</div> : null}
    {draft.kind === "device_status_change" ? <label className="block text-sm">حالة الجهاز المسجلة<select aria-label="حالة جهاز التثبيت المسجلة" className={control} value={draft.status}
      onChange={event => { const value = event.currentTarget.value as RetentionEditorDraft["status"]; if (["", "in_use", "not_in_use", "lost", "removed", "unknown"].includes(value)) update("status", value); }}>
      <option value="">اختر صراحةً</option><option value="in_use">قيد الاستخدام بحسب التدوين</option><option value="not_in_use">غير مستخدم بحسب التدوين</option><option value="lost">مفقود</option><option value="removed">أُزيل</option><option value="unknown">غير معلوم</option>
    </select></label> : null}
    {draft.kind === "followup_intent" ? <div className="space-y-3">
      <p className="text-sm">نية متابعة فقط؛ لا يُنشأ موعد ولا تُغيّر حالة تأخر الشدّات.</p>
      <label className="block text-sm">التاريخ المطلوب، إن عُرف<input aria-label="تاريخ نية متابعة التثبيت" type="date" className={control} value={draft.dueOn} onChange={event => update("dueOn", event.currentTarget.value)} /></label>
      <label className="block text-sm">الفاصل بالأيام، إن حُدد<input aria-label="فاصل متابعة التثبيت بالأيام" inputMode="numeric" className={control} value={draft.intervalDays} maxLength={4} onChange={event => update("intervalDays", event.currentTarget.value)} /></label>
      <label className="block text-sm">نطاق المتابعة<textarea aria-label="نطاق متابعة التثبيت" className={control} maxLength={1000} value={draft.followupScope} onChange={event => update("followupScope", event.currentTarget.value)} /></label>
    </div> : null}
    <label className="block text-sm">ملاحظة التدوين<textarea aria-label="ملاحظة تدوين التثبيت" className={control} maxLength={4000} value={draft.note} onChange={event => update("note", event.currentTarget.value)} /></label>
    <label className="block text-sm font-semibold">سبب حفظ السجل<textarea aria-label="سبب حفظ سجل التثبيت" className={control} maxLength={500} value={draft.reason} onChange={event => update("reason", event.currentTarget.value)} /></label>
    {!props.documentReferencesManaged ? <p className="text-xs text-slate-600">المستندات المرتبطة بهذه المسودة: {draft.documentIds.length ? draft.documentIds.map(id => `#${id}`).join("، ") : "لا توجد"}. إضافة روابط صور جديدة تحتاج اختيارًا مخولًا ولم تُخمن هنا.</p> : null}
  </fieldset>;
}
