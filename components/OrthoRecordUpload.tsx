"use client";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { PHOTO_STAGE_LABEL } from "@/lib/ortho-photos";
import { readRecordUploadCommand, RECORD_IMAGE_LIMIT } from "@/lib/ortho-record-upload";
import type { RecordUploadOwner } from "@/lib/ortho-record-upload-owner";
function makeUploadView(owner: RecordUploadOwner) { let live = false; return { active: () => live && owner.active(), activate: () => { live = true; }, retire: () => { live = false; } }; }
const control = "min-h-11 w-full rounded-lg border p-2 disabled:opacity-50";
export function OrthoRecordUpload({ owner, caseId }: { owner: RecordUploadOwner; caseId: number }) {
  const view = useMemo(() => makeUploadView(owner), [owner]);
  useLayoutEffect(() => { view.activate(); return view.retire; }, [view]);
  const draft = owner.draft, file = draft?.file;
  const [message, setMessage] = useState(""), [hashing, setHashing] = useState(false), [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file); setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!draft || !owner.active()) return null;
  const editable = owner.editable() && !hashing;
  async function save(retry = false) {
    if (!owner.active() || owner.busy || !retry && !owner.editable()) return;
    let lease: ReturnType<RecordUploadOwner["begin"]> = null;
    try {
      if (retry) lease = owner.beginRetry();
      else {
        const candidate = owner.draft;
        if (!candidate || !candidate.stage || !candidate.dateState) { setMessage("اختر مرحلة الصورة وحالة تاريخ التصوير، أو صرّح بأنهما غير معلومين."); return; }
        if (!candidate.file.size || candidate.file.size > RECORD_IMAGE_LIMIT || !["image/jpeg", "image/png", "image/webp"].includes(candidate.file.type)) { setMessage("اختر JPEG أو PNG أو WebP لا تتجاوز 25 ميغابايت؛ قد يكون حد المركز أقل."); return; }
        setHashing(true);
        const bytes = await candidate.file.arrayBuffer();
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
        if (!view.active() || !owner.active() || owner.draft !== candidate || !owner.editable()) return;
        const command = readRecordUploadCommand({ schemaVersion: 1, clientRequestId: crypto.randomUUID(), title: candidate.title, photoView: candidate.photoView,
          photoStage: candidate.stage === "unknown" ? null : candidate.stage,
          occurrence: { state: candidate.dateState, takenOn: candidate.dateState === "unknown" ? null : candidate.takenOn, sourceNote: candidate.sourceNote },
          file: { sha256, mimeType: candidate.file.type, sizeBytes: candidate.file.size } });
        lease = owner.begin(command);
      }
    } catch { if (view.active() && owner.active()) setMessage("راجع العنوان والتاريخ ومصدر الصورة؛ لم يبدأ الرفع."); }
    finally { if (view.active() && owner.active()) setHashing(false); }
    if (!lease) return;
    setMessage(""); const timer = setTimeout(lease.abort, 20000); let confirmed = false;
    try {
      const response = await fetch(`/api/ortho/${caseId}/record-uploads`, { method: "POST", body: lease.form(), signal: lease.signal });
      if (!lease.current() || !lease.checkHeaders(response)) return;
      if (response.redirected || response.status >= 500) throw Error("unconfirmed");
      const body: unknown = await response.json(); if (!lease.current()) return;
      if (!response.ok) {
        if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== false || !("code" in body) || typeof body.code !== "string"
          || !("message" in body) || typeof body.message !== "string") throw Error("unconfirmed");
        lease.refuse(response.status);
        if (view.active()) setMessage(body.message);
        return;
      }
      confirmed = !!await lease.confirm(body, response.status);
      if (!confirmed) throw Error("unconfirmed");
    } catch { if (lease.current()) { lease.markUncertain(); if (view.active()) setMessage("لم تتأكد نتيجة الرفع. احتُفظ بالصورة والطلب للتحقق دون إنشاء نسخة أخرى."); } }
    finally { clearTimeout(timer); lease.finish(); }
  }
  return <section aria-label="توثيق الصورة قبل رفعها" className="space-y-3 rounded-xl border border-navy-300 bg-navy-50 p-3">
    <h4 className="font-bold">توثيق الصورة قبل رفعها</h4>
    <p className="text-sm">الأصل محفوظ كما اختير. أدخل تاريخ التصوير ومرحلة الحالة من المصدر؛ تاريخ الرفع لا يُستخدم بدلاً عنهما.</p>
    {preview && preview.file === file && <img src={preview.url} alt="معاينة الصورة المختارة قبل الرفع" className="max-h-64 max-w-full rounded-lg object-contain" />}
    <label className="block">عنوان الصورة<input aria-label="عنوان صورة التقويم" className={control} value={draft.title} maxLength={120} disabled={!editable} onChange={event => owner.update({ title: event.target.value })} /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>مرحلة الصورة<select aria-label="مرحلة صورة التقويم" className={control} value={draft.stage} disabled={!editable} onChange={event => owner.update({ stage: event.target.value as typeof draft.stage })}><option value="">اختر من المصدر…</option>{Object.entries(PHOTO_STAGE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="unknown">المرحلة غير معلومة</option></select></label>
      <label>حالة تاريخ التصوير<select aria-label="حالة تاريخ تصوير التقويم" className={control} value={draft.dateState} disabled={!editable} onChange={event => owner.update({ dateState: event.target.value as typeof draft.dateState, takenOn: "" })}><option value="">اختر حالة التاريخ…</option><option value="known">معلوم من المصدر</option><option value="unknown">غير معلوم</option></select></label>
      {draft.dateState === "known" && <label>تاريخ التصوير<input aria-label="تاريخ تصوير التقويم" type="date" className={control} value={draft.takenOn} disabled={!editable} onChange={event => owner.update({ takenOn: event.target.value })} /></label>}
    </div>
    <label className="block">مصدر الصورة والتاريخ، وتوضيح ما لم يُعرف<textarea aria-label="مصدر صورة التقويم وتاريخها" className={control} value={draft.sourceNote} maxLength={200} disabled={!editable} onChange={event => owner.update({ sourceNote: event.target.value })} /></label>
    {message && <p role="alert">{message}</p>}{hashing && <p role="status">جارٍ التحقق من بصمة الصورة…</p>}{owner.busy && <p role="status">جارٍ حفظ الصورة وبيانات مصدرها…</p>}
    <div className="flex flex-wrap gap-2">
      {owner.uncertain ? <button type="button" disabled={owner.busy} className="min-h-11 rounded-lg border bg-white px-3" onClick={() => void save(true)}>التحقق بنفس طلب رفع الصورة</button>
        : <button type="button" disabled={!editable} className="min-h-11 rounded-lg bg-navy-800 px-3 text-white" onClick={() => void save()}>حفظ الصورة ومصدرها</button>}
      <button type="button" disabled={!editable} className="min-h-11 rounded-lg border bg-white px-3" onClick={() => { if (owner.editable() && window.confirm("تجاهل الصورة المختارة وبياناتها غير المحفوظة؟")) owner.discard(); }}>تجاهل الصورة غير المرفوعة</button>
    </div>
  </section>;
}
