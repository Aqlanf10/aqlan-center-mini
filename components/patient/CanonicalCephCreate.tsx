"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CEPH_READ_PHASES, isCanonicalCephList, type CanonicalCephList, type CephReadPhase } from "@/lib/canonical-ceph-projection";
import { isCanonicalCephCreateContext, type CanonicalCephCreateContext } from "@/lib/canonical-ceph-create-projection";
import { formatClinicDate } from "@/lib/clinic-clock";
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const inputClass = "min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-2 text-sm";
/** Same pending-review policy as correction drafts: marker only, never automatic resend.
 * Mounted at the list owner so an unavailable Storage API does not lose an in-memory
 * pending intention when just the list or a detail view refreshes/closes. */
export function CanonicalCephCreate({ patientId, ownerKey, visible, list, onCreated, refreshStudies }: {
  patientId: string; ownerKey: string; visible: boolean; list: CanonicalCephList | null; onCreated: () => void; refreshStudies: () => void;
}) {
  const storageKey = `aqlan.ceph-create.pending:${encodeURIComponent(ownerKey)}:${patientId}`;
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [pending, setPending] = useState(initial.pending), [warning, setWarning] = useState(initial.warning);
  const [armed, setArmed] = useState(false), [writing, setWriting] = useState(false), [checkBusy, setLoading] = useState<{ list: CanonicalCephList | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null), [checked, setChecked] = useState<{ list: CanonicalCephList | null; status: "draft" | "none" } | null>(null);
  const [choiceRead, setContext] = useState<{ list: CanonicalCephList; before: number | null; data: CanonicalCephCreateContext | null; error: string | null } | null>(null), [pages, setPages] = useState<(number | null)[]>([null]);
  const [selected, setSelected] = useState(""), [phase, setPhase] = useState<CephReadPhase>("pretreatment"), [xrayDate, setXrayDate] = useState(""), [device, setDevice] = useState(""), [orthoCase, setOrthoCase] = useState(""), [refSet, setRefSet] = useState("builtin_default");
  const active = useRef(false), view = useRef(false), lifetime = useRef({ generation: 0 }), sending = useRef(false), pendingRef = useRef(initial.pending);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const before = pages.at(-1) ?? null;
  const currentChoices = choiceRead?.list === list && choiceRead.before === before ? choiceRead : null;
  const context = currentChoices?.data ?? null;
  const contextLoading = armed && !pending && !currentChoices;
  const validReference = context !== null && (context.referenceSets.some(r => r.key === refSet) || context.referenceSets.length === 0 && refSet === "builtin_default");
  const currentChecked = checked && checked.list === list ? checked.status : null;
  const loading = checkBusy !== null && checkBusy.list === list;
  // Retire the committed owner synchronously: a queued response may settle
  // between commit and passive effects, even after AbortController is cancelled.
  useLayoutEffect(() => { const owner = lifetime.current; active.current = true; return () => { active.current = false; owner.generation++; readController.current?.abort(); writeController.current?.abort(); }; }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || pendingRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  useLayoutEffect(() => {
    view.current = visible; const lease = ++lifetime.current.generation;
    readController.current?.abort(); writeController.current?.abort();
    if (!visible || !list || !armed || pendingRef.current) return;
    const controller = new AbortController(); readController.current = controller;
    const current = () => active.current && view.current && lifetime.current.generation === lease;
    const timeout = setTimeout(() => controller.abort(), 8000);
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/ceph?create=1${before === null ? "" : `&imagesBefore=${before}`}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => null); if (!current()) return;
        if (!response.ok || !isCanonicalCephCreateContext(data, Number(patientId), before)) throw new Error("تعذّر تحميل خيارات المسودة؛ لم يُعتبر سجل الصور فارغًا.");
        setContext({ list, before, data, error: null }); setMessage(null); setSelected(value => data.images.some(i => String(i.id) === value) ? value : "");
        setOrthoCase(value => data.orthoCases?.some(c => String(c.id) === value) ? value : "");
        setRefSet(value => data.referenceSets.some(r => r.key === value) ? value : data.referenceSets.length === 0 ? "builtin_default" : "");
      } catch { if (current()) setContext({ list, before, data: null, error: "تعذّر تحميل خيارات المسودة؛ حدّث الدراسات للتحقق من الصلاحية والخيارات." }); }
      finally { clearTimeout(timeout); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [visible, list, armed, before, patientId]);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  function newIntention() {
    if (!active.current || !view.current || sending.current || pendingRef.current) return;
    setContext(null); setPages([null]); setSelected(""); setPhase("pretreatment"); setXrayDate(""); setDevice(""); setOrthoCase(""); setRefSet("builtin_default"); setMessage(null); setArmed(true);
  }
  async function create() {
    if (!active.current || !view.current || sending.current || pendingRef.current || !armed || !context || !validReference || context.hasOpenDraft || !context.images.some(i => String(i.id) === selected)) return;
    sending.current = true; pendingRef.current = true; setPending(true); setWriting(true); setMessage(null); setChecked(null);
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const controller = new AbortController(); writeController.current = controller; const lease = lifetime.current.generation;
    const current = () => active.current && view.current && lifetime.current.generation === lease;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const uncertain = () => { setArmed(false); setContext(null); setMessage("لم تتأكد نتيجة فتح المسودة. تحقق من الدراسات؛ لن نعيد الطلب تلقائيًا."); };
    try {
      const response = await fetch(`/api/patients/${patientId}/ceph`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ documentId: Number(selected), phase, xrayDate: xrayDate || null, device: device || null, orthoCaseId: orthoCase ? Number(orthoCase) : null, refSet }) });
      const data = await response.json().catch(() => null); if (!current()) return;
      if (!response.ok) {
        if (response.status < 500 && data && (response.status === 401 || /^(STAFF_|ceph_create_|invalid_ceph_create$)/.test(String(data.code)))) {
          erase(); pendingRef.current = false; setPending(false); setArmed(false); setContext(null); setMessage(typeof data.message === "string" ? data.message : "لم تُفتح المسودة. حدّث الدراسات."); refreshStudies();
        } else uncertain();
        return;
      }
      if (!data || Object.keys(data).sort().join(",") !== "duplicateWarning,id" || !Number.isSafeInteger(data.id) || data.id <= 0 || !(data.duplicateWarning === null || typeof data.duplicateWarning === "string" && data.duplicateWarning.length < 500)) { uncertain(); return; }
      erase(); pendingRef.current = false; setPending(false); setArmed(false); setContext(null); onCreated();
    } catch { if (current()) uncertain(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setWriting(false); }
  }
  async function checkCurrent() {
    if (!active.current || !view.current || sending.current) return;
    const lease = ++lifetime.current.generation; readController.current?.abort(); const controller = new AbortController(); readController.current = controller; setLoading({ list }); setChecked(null); setMessage(null);
    const current = () => active.current && view.current && lifetime.current.generation === lease;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/patients/${patientId}/ceph`, { cache: "no-store", signal: controller.signal }); const data = await response.json().catch(() => null); if (!current()) return;
      if (!response.ok || !isCanonicalCephList(data, Number(patientId))) throw new Error("unverified");
      setChecked({ list, status: data.analyses.some(s => s.status === "draft") ? "draft" : "none" });
    } catch { if (current()) setMessage("تعذّر التحقق من الدراسات. لم يُرسل طلب آخر."); }
    finally { clearTimeout(timeout); if (current()) setLoading(null); }
  }
  if (!visible) return null;
  const image = context?.images.find(i => String(i.id) === selected);
  return <div data-testid="canonical-ceph-create" className="max-w-full space-y-3 rounded-xl border border-slate-200 p-3 text-sm [overflow-wrap:anywhere]">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. الاستعادة بعد إعادة تحميل الصفحة غير مضمونة؛ تحقق من النتيجة قبل المغادرة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>{writing ? "جارٍ تأكيد فتح المسودة…" : "طلب فتح مسودة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال."}</p>
      <button type="button" className={button} disabled={writing || loading} onClick={() => { void checkCurrent(); }}>التحقق من الدراسات الحالية</button>
      {currentChecked === "draft" ? <p>توجد مسودة حالية. راجعها من القائمة؛ وجودها لا يثبت نتيجة طلب بعينه.</p> : null}
      {currentChecked === "none" ? <><p>لا توجد مسودة حالية؛ قد يكون طلب سابق نُفذ ثم أُغلقت مسودته. راجع السجل قبل نية جديدة.</p><button type="button" className={button} disabled={writing || loading} onClick={() => { if (!active.current || !view.current || sending.current) return; erase(); pendingRef.current = false; setPending(false); setChecked(null); setArmed(false); setContext(null); }}>راجعت السجل، السماح بطلب جديد</button></> : null}
    </div> : armed ? <div className="space-y-3">
      <h3 className="font-bold text-navy-900">فتح مسودة سيفالومتري</h3>
      <p className="text-xs text-slate-600">اختر صورة مسجلة للمريض. تُفتح مسودة فارغة غير معتمدة، دون نسخ تشخيص أو قياسات سابقة.</p>
      {contextLoading ? <p role="status">جارٍ تحميل خيارات المسودة…</p> : null}
      {currentChoices?.error ? <p role="alert">{currentChoices.error}</p> : null}
      {context?.hasOpenDraft ? <p role="status" className="text-amber-800">للمريض مسودة مفتوحة؛ راجعها من قائمة الدراسات قبل فتح أخرى.</p> : null}
      {context ? <>
        <label className="block space-y-1"><span>الصورة المسجلة</span><select aria-label="الصورة المسجلة" className={inputClass} value={selected} onChange={e => setSelected(e.target.value)}><option value="">اختر صورة</option>{context.images.map(i => <option key={i.id} value={i.id}>{i.title} — {i.takenOn ?? formatClinicDate(i.uploadedAt, context.clinicTimeZone)}</option>)}</select></label>
        {!context.images.length ? <p>لا توجد صور متاحة في هذه الصفحة.</p> : null}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={pages.length <= 1 || loading} onClick={() => { setSelected(""); setPages(p => p.slice(0, -1)); }}>صور أحدث</button><button type="button" className={button} disabled={context.nextImagesBefore === null || loading} onClick={() => { if (context.nextImagesBefore !== null) { setSelected(""); setPages(p => [...p, context.nextImagesBefore]); } }}>صور أقدم</button></div>
        {image && image.previousStudies > 0 ? <p className="rounded-lg bg-amber-50 p-2 text-amber-900">لهذه الصورة {image.previousStudies} دراسة سابقة. افتح دراسة أخرى فقط إن كان ذلك مقصودًا.</p> : null}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span>مرحلة الدراسة</span><select aria-label="مرحلة الدراسة" className={inputClass} value={phase} onChange={e => setPhase(e.target.value as CephReadPhase)}>{Object.entries(CEPH_READ_PHASES).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="space-y-1"><span>تاريخ التقاط الصورة</span><input aria-label="تاريخ التقاط الصورة" type="date" className={inputClass} value={xrayDate} onChange={e => setXrayDate(e.target.value)} /></label>
          {context.orthoCases !== null ? <label className="space-y-1"><span>حالة التقويم المرتبطة</span><select aria-label="حالة التقويم المرتبطة" className={inputClass} value={orthoCase} onChange={e => setOrthoCase(e.target.value)}><option value="">بدون ربط بحالة</option>{context.orthoCases.map(c => <option key={c.id} value={c.id}>حالة تقويم #{c.id}</option>)}</select></label> : null}
          <label className="space-y-1"><span>المجموعة المرجعية</span><select aria-label="المجموعة المرجعية" className={inputClass} value={refSet} onChange={e => setRefSet(e.target.value)}>{context.referenceSets.length === 0 ? <option value="builtin_default">المرجع القياسي المدمج</option> : <option value="">اختر مجموعة مرجعية</option>}{context.referenceSets.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
          <label className="space-y-1"><span>جهاز الأشعة أو المركز (اختياري)</span><input aria-label="جهاز الأشعة أو المركز" maxLength={120} className={inputClass} value={device} onChange={e => setDevice(e.target.value)} /></label>
        </div>
        <button type="button" className={button} disabled={!image || !validReference || context.hasOpenDraft || loading || writing} onClick={() => { void create(); }}>إنشاء المسودة غير المعتمدة</button>
      </> : null}
      <button type="button" className={button} disabled={writing} onClick={() => { setArmed(false); setContext(null); setMessage(null); }}>إلغاء</button>
    </div> : <button type="button" className={button} onClick={newIntention}>فتح مسودة جديدة</button>}
  </div>;
}
