"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StrategyLifetime } from "./OrthoTreatmentStrategy";
import { readSpaceCommand, newSpacePlan, contactKey, mmToUm, SPACE_METHODS, type SpaceCommand, type SpacePlan, type SpaceArch, type SpaceContent } from "@/lib/ortho-space-ledger";
import { confirmsSpaceWrite, verifySpaceRead } from "@/lib/ortho-space-client";
import type { SpaceLedgerRead } from "@/lib/ortho-space-store";
const field = "mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm";
const button = "min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold disabled:opacity-40";
const mm = (n: number | null) => n === null ? "غير معلوم" : `${Number((n / 1000).toFixed(3))} mm`;
const archLabel = (a: SpaceArch) => a === "upper" ? "العلوي" : "السفلي";
const methods: Record<typeof SPACE_METHODS[number], string> = { expansion: "توسيع", distalization: "إرجاع خلفي", uprighting: "تصحيح الميل", derotation: "تصحيح الدوران", proclination: "إمالة أمامية", extraction: "قلع مخطط", other: "تقدير آخر" };
function draftOf(value: string): SpaceCommand | null {
  try { const r = JSON.parse(value); return r?.schemaVersion === 1 && r.content && ["plan", "ipr"].includes(r.content.kind) && typeof r.clientRequestId === "string" ? r : null; } catch { return null; }
}
function Amount({ label, value, change }: { label: string; value: number | null; change: (n: number | null) => void }) {
  return <label className="block text-xs">{label}<input className={field} aria-label={label} type="number" step="0.001" min="0" inputMode="decimal" value={value === null ? "" : value / 1000}
    onChange={e => { const n = mmToUm(e.target.value); if (n !== undefined) change(n); }} placeholder="غير معلوم" /></label>;
}
export default function OrthoSpaceLedger({ patientId, orthoCaseId, lifetime }: { patientId: number; orthoCaseId: number; lifetime: StrategyLifetime }) {
  const identity = useMemo(() => ({ patientId, orthoCaseId, lease: lifetime.identity }), [patientId, orthoCaseId, lifetime.identity]);
  const active = useRef(identity), lifeRef = useRef(lifetime);
  useLayoutEffect(() => { lifeRef.current = lifetime; }, [lifetime]);
  useLayoutEffect(() => { active.current = identity; return () => { if (active.current === identity) active.current = { ...identity }; }; }, [identity]);
  const [reload, setReload] = useState(0);
  const requestIdentity = useMemo(() => ({ identity, reload, version: lifetime.readVersion }), [identity, reload, lifetime.readVersion]);
  const [read, setRead] = useState<{ identity: typeof requestIdentity; data: SpaceLedgerRead | null; error: string | null }>({ identity: requestIdentity, data: null, error: null });
  const [message, setMessage] = useState<string | null>(null);
  const data = read.identity === requestIdentity ? read.data : null;
  const draft = draftOf(lifetime.values.document), malformed = Boolean(lifetime.values.document && !draft);
  const blocked = !data || !data.writable || !lifetime.editable() || lifetime.busy || lifetime.uncertain;
  useEffect(() => {
    const controller = new AbortController(), life = lifeRef.current;
    const current = () => active.current === identity && life.active() && !controller.signal.aborted;
    const timer = setTimeout(() => { if (current()) { setRead({ identity: requestIdentity, data: null, error: "تعذّر إكمال القراءة؛ أعد تحديث السجل." }); controller.abort(); } }, 15000);
    void (async () => {
      try {
        const response = await fetch(`/api/ortho/${orthoCaseId}/space-ledger?patientId=${patientId}`, { cache: "no-store", signal: controller.signal });
        if (!current()) return;
        if ([401, 403].includes(response.status)) { life.denied(); throw Error("غير مصرّح بسجل المسافات لهذه الحالة."); }
        if (!response.ok || response.redirected) throw Error("تعذّر قراءة سجل المسافات؛ يلزم ربط الحالة السريري وصلاحية الخطة.");
        const data = await verifySpaceRead(await response.json(), patientId, orthoCaseId);
        if (!current()) return;
        if (!data) throw Error("تعذّر التحقق من هوية السجل ونسخه؛ لم يُعتبر فارغاً.");
        setRead({ identity: requestIdentity, data, error: null });
      } catch (e) { if (current()) setRead({ identity: requestIdentity, data: null, error: e instanceof Error ? e.message : "تعذّر القراءة." }); }
      finally { clearTimeout(timer); }
    })();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [identity, requestIdentity, patientId, orthoCaseId]);
  const update = (next: SpaceCommand) => { if (!blocked) lifetime.change("document", JSON.stringify(next)); };
  const content = (next: SpaceContent) => { if (draft) update({ ...draft, content: next }); };
  const start = (c: SpaceContent) => {
    if (blocked || !data || draft || malformed) return;
    lifetime.settle("document", JSON.stringify({ schemaVersion: 1, clientRequestId: crypto.randomUUID(), expectedHeadId: data.headId, reason: "", content: c })); setMessage(null);
  };
  const startPlan = (arch: SpaceArch) => {
    const b = data?.choices.baselines.find(b => b.arch === arch), s = data?.choices.strategy;
    if (!b || !s) return;
    const old = data?.history.find(r => r.content.authored.kind === "plan" && r.content.authored.arch === arch)?.content.authored;
    start(newSpacePlan(arch, s.id, b.ref, old?.kind === "plan" ? old : undefined));
  };
  const startIpr = (planId: number, teeth: [number, number], arch: SpaceArch) => start({ kind: "ipr", arch, planEntryId: planId, teeth, adjustmentId: 0, performedUm: null, measurementNote: "", supersedesEntryId: null, reviewReason: null });
  const discard = () => { if (!lifetime.busy && !lifetime.uncertain && lifetime.active() && (!lifetime.dirty || window.confirm("تجاهل مسودة المسافات غير المحفوظة؟"))) lifetime.settle("document", ""); };
  async function save(retry = false) {
    if (!data || !draft || active.current !== identity || !lifetime.active() || lifetime.busy || (retry ? !lifetime.uncertain : blocked)) return;
    const parsed = readSpaceCommand(draft); if (!parsed.ok) { setMessage("أكمل السبب والمراجع ونصوص الخطة والتماس؛ الأرقام المجهولة تُترك فارغة. لا تكرر تقديرين ضمن مجموعة تداخل واحدة."); return; }
    const command = parsed.value, operation = retry ? lifetime.beginRetry?.() : lifetime.begin(); if (!operation) return;
    let confirmed = false;
    const show = (m: string) => { if (active.current === identity) setMessage(m); };
    try {
      const response = await fetch(`/api/ortho/${orthoCaseId}/space-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId, command }) });
      if (!operation.current() || !operation.checkHeaders(response)) return;
      if (response.redirected || response.status >= 500 || !response.ok && ![400, 401, 403, 404, 409, 413].includes(response.status)) { operation.markUncertain(); show("نتيجة الحفظ غير مؤكدة؛ تحقق بإعادة نفس الطلب."); return; }
      const raw: unknown = await response.json().catch(() => null); if (!operation.current()) return;
      if (!response.ok) { if (retry) operation.markUncertain(); const error = raw as { message?: string } | null; show(error?.message ?? "تعذّر الحفظ؛ احتُفظ بالمسودة."); return; }
      confirmed = await confirmsSpaceWrite(raw, command, patientId, orthoCaseId, data.clinicalCaseId, response.status);
      if (!operation.current()) return;
      if (!confirmed) { operation.markUncertain(); show("الرد لا يؤكد الطلب نفسه؛ احتُفظ بالمسودة للتحقق."); }
    } catch { if (operation.current()) { operation.markUncertain(); show("انقطع تأكيد الحفظ؛ أعد نفس الطلب للتحقق دون تكرار الحدث."); } }
    finally { const current = operation.current(); operation.finish(); if (current && confirmed) { lifetime.settle("document", ""); lifetime.refresh(); show("حُفظ السجل. جارٍ إعادة قراءة النسخة المعتمدة."); } }
  }
  const p = draft?.content.kind === "plan" ? draft.content : null, ipr = draft?.content.kind === "ipr" ? draft.content : null;
  const changePlan = (patch: Partial<SpacePlan>) => { if (p) content({ ...p, ...patch }); };
  return <section data-testid="ortho-space-ledger" aria-label="ميزانية المسافات وسجل IPR" className="min-w-0 space-y-3 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-black">ميزانية المسافات وسجل IPR</h4><button className={button} type="button" disabled={lifetime.busy} onClick={() => setReload(n => n + 1)}>تحديث سجل المسافات</button></div>
    <p className="text-xs text-slate-600">المخطط تقدير يراجعه الطبيب. المنفذ يُوثّق لكل تماس وجلسة فعلية؛ لا يثبت تلقائياً مقدار المسافة المتاحة لاحقاً. المجموع يخص الأحداث الموثقة هنا؛ لا يثبت عدم وجود IPR سابق غير مسجل. لا يوجد حد IPR افتراضي.</p>
    {read.identity === requestIdentity && read.error ? <p role="alert">{read.error}</p> : !data ? <p role="status">جارٍ التحقق من السجل…</p> : null}
    {message ? <p role="status" className="text-sm text-amber-900">{message}</p> : null}
    {malformed ? <p role="alert">تعذّر قراءة المسودة؛ احتُفظ بها دون استبدالها.</p> : null}
    {lifetime.uncertain ? <button type="button" className={button} disabled={lifetime.busy} onClick={() => void save(true)}>التحقق بإعادة نفس طلب المسافات</button> : null}
    {data ? <>
      {data.plans.map(plan => <div key={plan.entryId} className="space-y-2 rounded-xl bg-slate-50 p-3">
        <h5 className="font-bold">الفك {archLabel(plan.arch)} · خطة المسافات #{plan.entryId}</h5>
        {!plan.sourceCurrent || !plan.strategyCurrent ? <p role="status" className="text-sm text-amber-900">تغير مصدر القياسات أو الاستراتيجية؛ هذه النسخة محفوظة وتحتاج مراجعة الطبيب.</p> : null}
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt>المتاح ناقص المطلوب {plan.estimatedBaseline ? "المقدّر" : "المقاس"}</dt><dd dir="ltr">{Number(plan.budget.baselineDiscrepancyMm.toFixed(3))} mm</dd></div>
          <div><dt>المكاسب المقترحة شاملة IPR</dt><dd><bdi>{mm(plan.budget.gainsUm)}</bdi></dd></div>
          <div><dt>الاستخدامات الإضافية المخططة</dt><dd><bdi>{mm(plan.budget.usesUm)}</bdi></dd></div>
          <div><dt>الرصيد التقديري بعد الخطة</dt><dd><bdi>{plan.budget.estimatedBalanceMm === null ? "غير مكتمل" : `${Number(plan.budget.estimatedBalanceMm.toFixed(3))} mm`}</bdi></dd></div>
        </dl>
        {(() => { const saved = data.history.find(h => h.id === plan.entryId)?.content.authored; return saved?.kind === "plan" ? <details><summary className="min-h-11 cursor-pointer py-3 text-xs font-bold">تفاصيل المكاسب والاستخدامات ومبرراتها</summary>
          <p className="my-2 text-xs">{saved.rationale}</p><p className="text-xs">البدائل: {saved.alternatives}</p>
          {saved.gains.map(g => <p key={g.key} className="my-2 text-xs">{methods[g.method]} · {g.label} · <bdi>{mm(g.estimateUm)}</bdi> · {g.included ? "محتسب" : "غير محتسب / بديل"} · التداخل: {g.overlapGroup} · {g.rationale}</p>)}
          {saved.uses.map(u => <p key={u.key} className="my-2 text-xs">استخدام إضافي: {u.label} · <bdi>{mm(u.amountUm)}</bdi></p>)}
        </details> : null; })()}
        {plan.contacts.map(c => <div key={contactKey(c.teeth)} className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-2 text-xs"><bdi>FDI {contactKey(c.teeth)}</bdi><span>المخطط <bdi>{mm(c.plannedUm)}</bdi></span><span>المكسب الإضافي المحتسب <bdi>{mm(c.budgetGainUm)}</bdi></span><span>الموثق المنفذ <bdi>{mm(c.performedUm)}</bdi></span><span>حد الطبيب <bdi>{mm(c.clinicianLimitUm)}</bdi></span>{c.review.length ? <strong className="text-amber-900">يحتاج مراجعة المقادير</strong> : null}
          <button type="button" className={button} disabled={blocked || !!draft || malformed} onClick={() => startIpr(plan.entryId, c.teeth, plan.arch)}>تسجيل IPR لهذا التماس</button></div>)}
      </div>)}
      {!draft && data.writable ? <div className="flex flex-wrap gap-2">{(["upper", "lower"] as const).map(arch => <button type="button" className={button} key={arch} disabled={blocked || malformed || !data.choices.strategy || !data.choices.baselines.some(b => b.arch === arch)} onClick={() => startPlan(arch)}>مراجعة ميزانية الفك {archLabel(arch)}</button>)}
        {!data.choices.strategy || !data.choices.baselines.length ? <p className="w-full text-xs">احفظ تحليل مساحة قابلًا للاستخدام وخطة مرتبطة بالمشاكل أولاً؛ ستُستخدم القياسات نفسها دون إعادة إدخالها.</p> : null}</div> : null}
      {draft ? <fieldset disabled={blocked} className="min-w-0 space-y-3 rounded-xl border p-3"><legend className="px-2 font-bold">{p ? `مسودة ميزانية الفك ${archLabel(p.arch)}` : "توثيق IPR منفذ"}</legend>
        {draft.expectedHeadId !== data.headId ? <p role="alert" className="text-sm text-amber-900">تغير السجل منذ فتح المسودة. راجع الأحداث الجديدة قبل إعداد طلب جديد.</p> : null}
        {p ? <>
          <p className="text-xs">نسخة التقييم #{p.baseline.id} · التحليل {p.baseline.member} · نسخة الاستراتيجية #{p.strategyRevisionId}</p>
          <label className="block text-xs">التحليل المرجعي للمساحة<select aria-label="التحليل المرجعي للمساحة" className={field} value={`${p.baseline.id}:${p.baseline.member}`} onChange={e => { const b = data.choices.baselines.find(b => `${b.ref.id}:${b.ref.member}` === e.target.value && b.arch === p.arch); if (b) content({ ...newSpacePlan(p.arch, p.strategyRevisionId, b.ref, p), rationale: p.rationale, alternatives: p.alternatives }); }}>
            {data.choices.baselines.filter(b => b.arch === p.arch).map(b => <option key={`${b.ref.id}:${b.ref.member}`} value={`${b.ref.id}:${b.ref.member}`}>{b.estimated ? "تقدير الأسنان المختلطة" : "تحليل المسافة المقاسة"} · {b.ref.member} · المتاح ناقص المطلوب {`\u2066${Number(b.discrepancyMm.toFixed(3))} mm\u2069`}</option>)}
          </select></label>
          <p className="text-xs">عند تغيير مرجع القياس أو الاستراتيجية، تصبح تقديرات المكاسب والاستخدامات غير معلومة حتى يعيد الطبيب تقديرها؛ تبقى خطة التماسات السابقة محفوظة.</p>
          <label className="block text-xs">سبب الاختيار والاستطباب<textarea className={field} value={p.rationale} onChange={e => changePlan({ rationale: e.target.value })} maxLength={1000} /></label>
          <label className="block text-xs">البدائل التي راجعها الطبيب<textarea className={field} value={p.alternatives} onChange={e => changePlan({ alternatives: e.target.value })} maxLength={1000} /></label>
          <h6 className="font-bold">IPR المخطط لكل تماس</h6><p className="text-xs">اختر سنّين وتحقق من وجود التماس فعلياً. المخطط مقدار تراكمي للتماس كله. حدد منفصلاً الجزء الإضافي الذي لم يحتسب في قياس المساحة المرجعي؛ اتركه مجهولاً إذا لم يتحقق التوقيت.</p>
          {p.contacts.map((c, i) => <div key={i} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-2">
            {([0, 1] as const).map(j => <label key={j} className="text-xs">{`السن ${j + 1} للتماس ${i + 1}`}<select aria-label={`السن ${j + 1} للتماس ${i + 1}`} className={field} value={c.teeth[j]} onChange={e => changePlan({ contacts: p.contacts.map((v, k) => k === i ? { ...v, teeth: v.teeth.map((t, index) => index === j ? Number(e.target.value) : t) as [number, number] } : v) })}><option value={0}>اختر السن</option>{(p.arch === "upper" ? [1, 2] : [3, 4]).flatMap(q => Array.from({ length: 8 }, (_, n) => q * 10 + n + 1)).map(t => <option key={t} value={t}>{t}</option>)}</select></label>)}
            <Amount label={`IPR المخطط للتماس ${i + 1} (mm)`} value={c.plannedUm} change={n => changePlan({ contacts: p.contacts.map((v, k) => k === i ? { ...v, plannedUm: n } : v) })} />
            <Amount label={`المكسب الإضافي بعد قياس المرجع للتماس ${i + 1} (mm)`} value={c.budgetGainUm} change={n => changePlan({ contacts: p.contacts.map((v, k) => k === i ? { ...v, budgetGainUm: n } : v) })} />
            <Amount label={`حد الطبيب للتماس ${i + 1} (mm)، اختياري`} value={c.clinicianLimitUm} change={n => changePlan({ contacts: p.contacts.map((v, k) => k === i ? { ...v, clinicianLimitUm: n } : v) })} />
            <label className="text-xs sm:col-span-2">توثيق فحص التماس ومبرر المقدار<input className={field} value={c.note} onChange={e => changePlan({ contacts: p.contacts.map((v, k) => k === i ? { ...v, note: e.target.value } : v) })} maxLength={1000} /></label>
            <button className={button} type="button" onClick={() => changePlan({ contacts: p.contacts.filter((_, k) => k !== i) })}>إزالة من هذه المسودة</button>
          </div>)}
          <button className={button} type="button" disabled={p.contacts.length >= 32} onClick={() => changePlan({ contacts: [...p.contacts, { teeth: [0, 0], plannedUm: null, budgetGainUm: null, clinicianLimitUm: null, note: "" }] })}>إضافة تماس IPR</button>
          <details><summary className="min-h-11 cursor-pointer py-3 font-bold">المكاسب الأخرى والاستخدامات ({p.gains.length} / {p.uses.length})</summary>
            <p className="my-2 text-xs">الأرقام تقديرات الطبيب وليست نسباً جاهزة. ضع التقديرات المتداخلة في المجموعة نفسها واختر واحداً فقط للجمع. لا تضف IPR هنا؛ يُجمع من التماسات.</p>
            {p.gains.map((g, i) => <div key={g.key} className="my-2 grid gap-2 rounded-lg border p-2 sm:grid-cols-2">
              <label className="text-xs">الطريقة<select className={field} value={g.method} onChange={e => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, method: e.target.value as typeof g.method } : v) })}>{SPACE_METHODS.map(m => <option key={m} value={m}>{methods[m]}</option>)}</select></label>
              <label className="text-xs">وصف التقدير<input className={field} value={g.label} onChange={e => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, label: e.target.value } : v) })} /></label>
              <Amount label={`المكسب المقترح ${i + 1} (mm)`} value={g.estimateUm} change={n => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, estimateUm: n } : v) })} />
              <label className="text-xs">منطقة التداخل أو مصدر المساحة المشترك<input className={field} value={g.overlapGroup} onChange={e => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, overlapGroup: e.target.value } : v) })} /></label>
              <label className="text-xs sm:col-span-2">مبرر التقدير وعلاقته ببقية المكاسب<input className={field} value={g.rationale} onChange={e => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, rationale: e.target.value } : v) })} /></label>
              <label className="text-xs"><input type="checkbox" checked={g.included} onChange={e => changePlan({ gains: p.gains.map((v, k) => k === i ? { ...v, included: e.target.checked } : v) })} /> يُحتسب ضمن الخطة المختارة</label>
              <button type="button" className={button} onClick={() => changePlan({ gains: p.gains.filter((_, k) => k !== i) })}>إزالة التقدير</button>
            </div>)}
            <button type="button" className={button} disabled={p.gains.length >= 30} onClick={() => changePlan({ gains: [...p.gains, { key: crypto.randomUUID(), method: "other", label: "", estimateUm: null, overlapGroup: "", included: false, rationale: "" }] })}>إضافة مكسب مقترح</button>
            <p className="my-2 text-xs">سجّل الاستخدامات الإضافية فقط؛ النقص في التحليل محسوب بالفعل.</p>
            {p.uses.map((u, i) => <div key={u.key} className="my-2 grid gap-2 sm:grid-cols-2"><label className="text-xs">وصف الاستخدام الإضافي<input className={field} value={u.label} onChange={e => changePlan({ uses: p.uses.map((v, k) => k === i ? { ...v, label: e.target.value } : v) })} /></label>
              <Amount label={`الاستخدام الإضافي ${i + 1} (mm)`} value={u.amountUm} change={n => changePlan({ uses: p.uses.map((v, k) => k === i ? { ...v, amountUm: n } : v) })} /><button type="button" className={button} onClick={() => changePlan({ uses: p.uses.filter((_, k) => k !== i) })}>إزالة الاستخدام</button></div>)}
            <button type="button" className={button} disabled={p.uses.length >= 30} onClick={() => changePlan({ uses: [...p.uses, { key: crypto.randomUUID(), label: "", amountUm: null }] })}>إضافة استخدام مخطط</button>
          </details>
        </> : ipr ? <>
          <p className="text-sm">تماس <bdi>FDI {contactKey(ipr.teeth)}</bdi> · الفك {archLabel(ipr.arch)}{ipr.supersedesEntryId !== null ? ` · تصحيح الحدث #${ipr.supersedesEntryId}` : ""}</p>
          <label className="block text-xs">جلسة التقويم الفعلية<select aria-label="جلسة التقويم الفعلية" className={field} value={ipr.adjustmentId} disabled={ipr.supersedesEntryId !== null} onChange={e => content({ ...ipr, adjustmentId: Number(e.target.value) })}><option value={0}>اختر جلسة محفوظة</option>{data.choices.adjustments.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · جلسة #{a.id} · زيارة #{a.visitId} · {a.recordedBy}</option>)}</select></label>
          <Amount label="مقدار IPR المنفذ في هذه الجلسة (mm)" value={ipr.performedUm} change={n => content({ ...ipr, performedUm: n })} />
          <label className="block text-xs">طريقة القياس ومصدر التوثيق<input className={field} value={ipr.measurementNote} maxLength={1000} onChange={e => content({ ...ipr, measurementNote: e.target.value })} /></label>
          <label className="block text-xs">مراجعة الطبيب عند تجاوز المخطط أو وجود مقدار مجهول<textarea className={field} value={ipr.reviewReason ?? ""} maxLength={1000} onChange={e => content({ ...ipr, reviewReason: e.target.value || null })} /></label>
        </> : null}
        <label className="block text-xs">سبب توثيق نسخة المسافات<textarea className={field} value={draft.reason} maxLength={500} onChange={e => update({ ...draft, reason: e.target.value })} /></label>
        <button type="button" className={button} disabled={draft.expectedHeadId !== data.headId} onClick={() => void save()}>حفظ سجل المسافات</button>
        {draft.expectedHeadId !== data.headId ? <button type="button" className={button} onClick={() => update({ ...draft, expectedHeadId: data.headId, clientRequestId: crypto.randomUUID() })}>راجعت الأحداث الجديدة؛ إعداد طلب جديد بهذه المسودة</button> : null}
      </fieldset> : null}
      {draft || malformed ? <button type="button" className={button} disabled={lifetime.busy || lifetime.uncertain} onClick={discard}>إغلاق مسودة المسافات</button> : null}
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">سجل النسخ والتصحيحات ({data.history.length})</summary>
        {data.history.map(h => <div key={h.id} className="my-2 space-y-1 border-b py-2 text-xs"><p>#{h.id} · {h.content.authored.kind === "plan" ? "ميزانية مخططة" : "IPR موثق"} · {h.createdBy} · <bdi>{h.createdAt}</bdi></p><p>{h.reason}</p>
          {h.content.authored.kind === "ipr" ? <><p><bdi>{contactKey(h.content.authored.teeth)}</bdi> · <bdi>{mm(h.content.authored.performedUm)}</bdi> · جلسة #{h.content.authored.adjustmentId} · <bdi>{h.content.adjustment?.occurredOn}</bdi></p><p>{h.content.authored.measurementNote}</p>{h.content.authored.reviewReason ? <p>مراجعة الطبيب: {h.content.authored.reviewReason}</p> : null}
            {data.ipr.current.some(e => e.id === h.id) ? <button type="button" className={button} disabled={blocked || !!draft || malformed} onClick={() => { if (h.content.authored.kind === "ipr") start({ ...h.content.authored, supersedesEntryId: h.id, reviewReason: null }); }}>تصحيح هذا الحدث</button> : <p>محفوظ في التاريخ؛ حلّ تصحيح موثق مكانه في المجموع.</p>}</> : <><p>{h.content.authored.rationale}</p><p>البدائل: {h.content.authored.alternatives}</p></>}
        </div>)}
      </details>
    </> : null}
  </section>;
}
