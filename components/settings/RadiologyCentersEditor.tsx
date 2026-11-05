"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useSessionActions } from "@/components/SessionProvider";
import { MAX_RADIOLOGY_CENTERS, RADIOLOGY_CENTERS_KEY as KEY, parseRadiologyCenters, type RadiologyCenter } from "@/lib/radiology-centers";

type EditorProps = {
  values: Record<string, string>; versions: Record<string, string | null>; editable: boolean;
  onSaved: (payload: Record<string, unknown>) => void;
};
export function RadiologyCentersEditor(props: EditorProps) {
  const { session, ready } = useSessionActions();
  const expectedActor = ready && session?.role === "admin" ? session.username : null;
  const ownerKey = JSON.stringify([ready, session?.username ?? null, session?.role ?? null, props.editable]);
  return <RadiologyCentersOwner key={ownerKey} {...props} expectedActor={expectedActor}/>;
}
function RadiologyCentersOwner({ values, versions, editable: admitted, onSaved, expectedActor }: EditorProps & { expectedActor: string | null }) {
  const editable = admitted && Boolean(expectedActor);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const parsed = parseRadiologyCenters(values[KEY] ?? "[]");
  const [draft, setDraft] = useState<RadiologyCenter[] | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [success, setSuccess] = useState(false);
  const shown = draft ?? (parsed.ok ? parsed.centers : []);
  const validation = parseRadiologyCenters(JSON.stringify(shown));
  const button = "min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold disabled:opacity-50";
  function open() {
    if (!alive.current || inFlight.current || !editable || !parsed.ok || !(KEY in versions)) return;
    setDraft(parsed.centers); setExpected(versions[KEY]); setError(null); setSuccess(false); setStale(false);
  }
  function update(id: string, patch: Partial<Pick<RadiologyCenter, "name" | "address" | "active">>) {
    if (!alive.current || inFlight.current || !editable) return;
    setDraft(current => current?.map(center => center.id === id ? { ...center, ...patch } : center) ?? null);
  }
  function add() {
    if (!alive.current || !editable || !draft || inFlight.current || shown.length >= MAX_RADIOLOGY_CENTERS) return;
    setDraft(current => [...(current ?? []), { id: crypto.randomUUID(), name: "", address: "", active: true }]);
  }
  function cancel() {
    if (!alive.current || inFlight.current) return;
    setDraft(null); setError(null); setStale(false);
  }
  async function save() {
    if (!alive.current || !draft || !editable || !expectedActor || inFlight.current || !validation.ok || stale) return;
    inFlight.current = true; setSaving(true); setError(null); setSuccess(false);
    try {
      const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [KEY]: JSON.stringify(validation.centers), __versions: { [KEY]: expected }, __expectedActor: expectedActor }) });
      if (!alive.current) return;
      const payload = await response.json().catch(() => null);
      if (!alive.current) return;
      if (!response.ok) {
        if (response.status === 409) { setStale(true); setError("تغيّرت القائمة من جهاز آخر. بقي تعديلك هنا؛ انسخه عند الحاجة ثم حدّث الصفحة لمراجعة النسخة الأحدث. لن نحفظ فوقها."); }
        else setError(typeof payload?.message === "string" ? payload.message : "تعذّر حفظ المراكز. بقي تعديلك دون تغيير.");
        return;
      }
      if (!payload || typeof payload[KEY] !== "string" || !parseRadiologyCenters(payload[KEY]).ok || !payload.__versions ||
        !(KEY in payload.__versions) || !(payload.__versions[KEY] === null || typeof payload.__versions[KEY] === "string")) {
        setStale(true); setError("استجابة الحفظ غير مكتملة. بقي تعديلك؛ حدّث الصفحة للتحقق قبل المحاولة مجددًا."); return;
      }
      onSaved(payload); setDraft(null); setSuccess(true);
    } catch {
      if (!alive.current) return;
      setStale(true); setError("تعذّر تأكيد الحفظ. بقي تعديلك؛ تحقق من الاتصال وحدّث الصفحة قبل المحاولة مجددًا.");
    } finally { if (alive.current) { inFlight.current = false; setSaving(false); } }
  }
  return <article aria-label="مراكز الأشعة" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-2">
    <h2 className="text-base font-black text-navy-950">مراكز الأشعة</h2>
    <p className="mt-2 text-sm text-slate-600">حدد الاسم والعنوان لاستخدامهما في طلب الأشعة. التعطيل يمنع الاختيار في الطلبات الجديدة دون تغيير الطلبات السابقة. هذه الشاشة تتيح التعطيل؛ إعادة ضبط الإعدادات المصرح بها قد تفرغ قائمة المراكز دون تغيير الطلبات الصادرة.</p>
    {!parsed.ok ? <p role="alert" className="mt-3 text-red-800">القائمة المحفوظة تحتاج مراجعة: {parsed.message} لم تُستبدل تلقائيًا.</p> : null}
    {!(KEY in versions) ? <p role="alert" className="mt-3 text-red-800">نسخة الإعداد مفقودة؛ حدّث الصفحة قبل التعديل.</p> : null}
    {parsed.ok && !shown.length ? <p className="my-6 text-sm text-slate-500">لم تُضف مراكز أشعة بعد. أضف بيانات المركز الفعلية؛ لا توجد مراكز افتراضية.</p> : null}
    <fieldset disabled={saving || !editable} className="mt-4 space-y-4">
      <legend className="sr-only">بيانات المراكز</legend>
      {shown.map((center, index) => <div key={center.id} className="rounded-xl border border-slate-200 p-4">
        {draft ? <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-bold">اسم المركز {index + 1}
            <input value={center.name} maxLength={160} onChange={event => update(center.id, { name: event.target.value })} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm font-bold">العنوان {index + 1}
            <input value={center.address} maxLength={400} onChange={event => update(center.id, { address: event.target.value })} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={center.active} onChange={event => update(center.id, { active: event.target.checked })} /> مفعّل للطلبات الجديدة — {center.name || `المركز ${index + 1}`}</label>
        </div> : <><h3 className="break-words font-bold">{center.name} <span className="text-xs text-slate-500">{center.active ? "مفعّل" : "معطّل"}</span></h3><p className="mt-2 break-words text-sm text-slate-600">{center.address}</p></>}
      </div>)}
      {draft ? <button type="button" className={button} disabled={shown.length >= MAX_RADIOLOGY_CENTERS} onClick={add}>إضافة مركز أشعة</button> : null}
    </fieldset>
    {draft && !validation.ok ? <p role="alert" className="mt-3 text-sm text-amber-800">{validation.message}</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-800">{error}</p> : null}
    {success ? <p role="status" className="mt-3 text-sm text-green-800">حُفظت مراكز الأشعة وسُجّل التغيير.</p> : null}
    {editable ? <div className="mt-4 flex flex-wrap gap-2">
      {draft ? <><button type="button" className={`${button} bg-navy-950 text-white`} disabled={saving || !validation.ok || stale} onClick={() => void save()}>{saving ? "جارٍ الحفظ…" : "حفظ المراكز"}</button>
        <button type="button" className={button} disabled={saving} onClick={cancel}>إلغاء التعديلات</button></> :
        <button type="button" className={`${button} bg-navy-950 text-white`} disabled={!parsed.ok || !(KEY in versions)} onClick={open}>تعديل مراكز الأشعة</button>}
    </div> : <p className="mt-3 text-xs text-slate-500">للقراءة فقط</p>}
  </article>;
}
