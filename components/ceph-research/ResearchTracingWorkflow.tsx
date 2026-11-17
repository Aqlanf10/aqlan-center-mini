'use client';

import { useId, useState, type FormEvent, type MouseEvent } from 'react';
import { CORE_LANDMARK_IDS, type CoreLandmarkId } from '../../lib/ceph-core/steiner-core';
import { captureResearchSnapshot, newResearchDraft, reviewMark, setAnterior, setMark, setReference, sourcePixel, SYNTHETIC_IMAGE, workflowProgress, type ResearchSnapshot } from '../../lib/ceph-workflow/research-workflow';

const action = 'cursor-pointer rounded-xl border border-navy-200 px-3 py-2 text-sm hover:bg-navy-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-700 disabled:cursor-not-allowed disabled:opacity-50';
const input = 'w-full rounded-lg border border-navy-200 px-3 py-2 text-navy-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-700';

/** Unmounted research component. Never accepts patient images or stores records. */
export default function ResearchTracingWorkflow() {
  const uid = useId();
  const [draft, setDraft] = useState(newResearchDraft);
  const [active, setActive] = useState<CoreLandmarkId>('S');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [snapshots, setSnapshots] = useState<readonly ResearchSnapshot[]>([]);
  const progress = workflowProgress(draft);
  const readyToMark = !!draft.reference && !!draft.anterior;
  function attempt(fn: () => void) {
    try { fn(); setError(''); } catch (e) { setError(e instanceof Error && /[\u0600-\u06ff]/.test(e.message) ? e.message : 'تحقق من طول مرجع موجب ونقطتين مختلفتين داخل الرسم.'); }
  }
  function calibrate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const numeric = (key: string) => { const raw = String(data.get(key) ?? '').trim(); return raw === '' ? NaN : Number(raw); };
    attempt(() => {
      const updated = setReference(draft, { start: { column: numeric('start-column'), row: numeric('start-row') }, end: { column: numeric('end-column'), row: numeric('end-row') }, lengthMm: numeric('length') });
      setDraft(updated); setNotice('تم تطبيق معايرة اصطناعية. أعد مراجعة النقاط إن تغيّرت المعايرة.');
    });
  }
  function place(column: number, row: number) {
    attempt(() => { setDraft(setMark(draft, active, { column, row })); setNotice(`تم تحديد ${active}؛ لم تُراجع بعد.`); });
  }
  function clickGrid(event: MouseEvent<SVGSVGElement>) {
    if (!readyToMark) return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) { setError('تعذر تحويل موضع المؤشر؛ استخدم الإدخال الرقمي.'); return; }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const source = sourcePixel(point.x, point.y);
    if (source) place(source.column, source.row);
  }
  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const col = String(data.get('column') ?? '').trim(), row = String(data.get('row') ?? '').trim();
    place(col === '' ? NaN : Number(col), row === '' ? NaN : Number(row));
  }
  function capture() {
    attempt(() => { if (snapshots.length >= 20) throw new Error('بلغت حد عشرين لقطة لهذه الجلسة البحثية.'); const snapshot = captureResearchSnapshot(draft); setSnapshots(previous => previous.some(s => s.revision === snapshot.revision) ? previous : [...previous, snapshot]); setNotice('حُفظت لقطة مراجعة في ذاكرة هذه الشاشة فقط؛ ليست سجلًا سريريًا.'); });
  }
  return <section dir="rtl" lang="ar" aria-labelledby={`${uid}-title`} className="space-y-5 bg-canvas p-4 text-navy-900">
    <header><p className="text-sm font-semibold">مساحة البحث السيفالومتري</p><h2 id={`${uid}-title`} className="text-xl font-bold">المعايرة ← تحديد النقاط ← المراجعة</h2></header>
    <p className="rounded-xl border border-warning-300 bg-warning-50 p-3 text-warning-900">رسم اصطناعي للتجربة فقط، وليس أشعة أو بيانات مريض. لا نتائج تشخيصية ولا استخدام سريري. تُفقد المسودة واللقطات عند إغلاق الشاشة أو تحديثها.</p>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <div className="space-y-3 rounded-2xl border border-navy-200 bg-white p-3">
        <p id={`${uid}-grid-help`} className="text-sm">اختر نقطة ثم انقر الرسم، أو استخدم حقول الإحداثيات. أصل الإحداثيات أعلى اليسار؛ لا تتغير بتغير حجم العرض.</p>
        <svg viewBox="0 0 800 600" width="800" height="600" preserveAspectRatio="xMidYMid meet" className={`h-auto w-full border border-navy-200 bg-canvas ${readyToMark ? 'cursor-crosshair' : 'cursor-default'}`} onClick={clickGrid} role="img" aria-label="شبكة إحداثيات اصطناعية بدون صورة مريض" aria-describedby={`${uid}-grid-help`}>
          <title>شبكة اختبار هندسي فقط</title>
          {Array.from({ length: 15 }, (_, i) => <line key={`v${i}`} x1={(i + 1) * 50} x2={(i + 1) * 50} y1="0" y2="600" className="stroke-navy-100" />)}
          {Array.from({ length: 11 }, (_, i) => <line key={`h${i}`} y1={(i + 1) * 50} y2={(i + 1) * 50} x1="0" x2="800" className="stroke-navy-100" />)}
          {draft.reference && <line x1={draft.reference.start.column} y1={draft.reference.start.row} x2={draft.reference.end.column} y2={draft.reference.end.row} className="stroke-warning-700" strokeWidth="3" />}
          {CORE_LANDMARK_IDS.map(id => { const p = draft.marks[id]; return p ? <g key={id}><circle cx={p.column} cy={p.row} r={id === active ? 7 : 5} className={p.reviewed ? 'fill-success-700' : 'fill-navy-800'} /><text x={p.column + 10} y={p.row - 10} fontSize="16" direction="ltr" textAnchor="start" className="fill-navy-900">{id}{p.reviewed ? ' ✓' : ''}</text></g> : null; })}
        </svg>
        <p className="text-sm">الأبعاد: {SYNTHETIC_IMAGE.width} × {SYNTHETIC_IMAGE.height} بكسل. تمت مراجعة {progress.reviewed} من {progress.total} نقاط. النسخة {draft.revision}.</p>
      </div>
      <div className="space-y-4">
        <fieldset className="rounded-2xl border border-navy-200 bg-white p-4"><legend className="px-2 font-bold">١. الاتجاه والمعايرة</legend>
          <label htmlFor={`${uid}-orientation`}>اتجاه الأمام في الرسم</label>
          <select id={`${uid}-orientation`} className={input} value={draft.anterior ?? ''} onChange={e => { if (e.target.value === 'left' || e.target.value === 'right') { setDraft(setAnterior(draft, e.target.value)); setNotice('تغيّر الاتجاه؛ أعد مراجعة النقاط.'); } }}><option value="" disabled>اختر الاتجاه</option><option value="right">يمين الصورة</option><option value="left">يسار الصورة</option></select>
          <form noValidate onSubmit={calibrate} className="mt-3 space-y-3" aria-describedby={`${uid}-calibration-help ${uid}-error`}>
            <p id={`${uid}-calibration-help`} className="text-sm">مثال مرجعي اصطناعي: نقطتان تفصل بينهما مسافة معروفة. لا يثبت هذا مستوى معايرة المريض.</p>
            <div className="grid grid-cols-2 gap-2">{[['start-column', 'بداية المرجع: العمود', '100'], ['start-row', 'بداية المرجع: الصف', '100'], ['end-column', 'نهاية المرجع: العمود', '200'], ['end-row', 'نهاية المرجع: الصف', '100'], ['length', 'طول المرجع الاصطناعي (مم)', '10']].map(([name, label, value]) => <label key={name} className="text-sm">{label}<input name={name} aria-invalid={!!error} aria-describedby={`${uid}-error`} type="number" step="any" defaultValue={value} className={input} /></label>)}</div>
            <button className={action} type="submit">تطبيق المعايرة</button>
          </form>
        </fieldset>
        <fieldset className="rounded-2xl border border-navy-200 bg-white p-4" disabled={!readyToMark}><legend className="px-2 font-bold">٢. تحديد النقاط يدويًا</legend>
          {!readyToMark && <p className="text-sm">اختر الاتجاه وطبّق المعايرة أولًا.</p>}
          <label htmlFor={`${uid}-point`}>النقطة الحالية (تعريفاتها السريرية قيد المراجعة)</label>
          <select id={`${uid}-point`} className={input} value={active} onChange={e => { setActive(e.target.value as CoreLandmarkId); setError(''); }}>{CORE_LANDMARK_IDS.map(id => <option key={id} value={id}>{id}{draft.marks[id]?.reviewed ? ' — تمت المراجعة' : draft.marks[id] ? ' — تحتاج مراجعة' : ' — لم تُحدد'}</option>)}</select>
          <form key={`${active}-${draft.revision}`} noValidate onSubmit={manual} className="mt-3 space-y-3" aria-describedby={`${uid}-error`}>
            <div className="grid grid-cols-2 gap-2"><label>العمود<input className={input} name="column" aria-invalid={!!error} aria-describedby={`${uid}-error`} type="number" step="any" min="0" max="799.999" defaultValue={draft.marks[active]?.column ?? ''} /></label><label>الصف<input className={input} name="row" aria-invalid={!!error} aria-describedby={`${uid}-error`} type="number" step="any" min="0" max="599.999" defaultValue={draft.marks[active]?.row ?? ''} /></label></div>
            <button className={action} type="submit">تطبيق موضع النقطة</button>
          </form>
          <button type="button" className={`${action} mt-3`} disabled={!draft.marks[active] || draft.marks[active]?.reviewed} onClick={() => attempt(() => { setDraft(reviewMark(draft, active)); setNotice(`تمت مراجعة ${active} هندسيًا في هذه النسخة فقط.`); })}>تأكيد مراجعة موضع {active}</button>
        </fieldset>
      </div>
    </div>
    <p id={`${uid}-error`} role="alert" className="min-h-6 text-danger-700">{error}</p>
    <p role="status" className="min-h-6 text-sm">{notice}</p>
    <section className="space-y-3 rounded-2xl border border-navy-200 bg-white p-4" aria-labelledby={`${uid}-review`}><h3 id={`${uid}-review`} className="font-bold">٣. مراجعة النسخة</h3>
      <p>المراجعة هنا تخص مواضع اصطناعية، ولا تعني اعتماد التعريفات العلمية. أي تعديل على نقطة يلغي مراجعتها، وتغيير الاتجاه أو المعايرة يلغي مراجعة جميع النقاط.</p>
      <button type="button" className={action} disabled={!progress.ready || snapshots.length >= 20 || snapshots.some(s => s.revision === draft.revision)} onClick={capture}>حفظ لقطة بحثية في الذاكرة</button>
      {snapshots.length >= 20 && <p>بلغت حد عشرين لقطة لهذه الجلسة البحثية؛ اللقطات السابقة محفوظة في الذاكرة.</p>}
      {!snapshots.length ? <p className="text-sm">لا توجد لقطات مراجعة بعد.</p> : <ul className="space-y-2">{snapshots.map(s => <li key={s.revision}>نسخة {s.revision}: {s.mmPerPixel.toPrecision(5)} مم/بكسل اصطناعي؛ {Object.keys(s.marks).length} نقاط. {s.revision === draft.revision ? 'تطابق المسودة الحالية.' : 'لقطة سابقة محفوظة دون تعديل.'} غير معتمدة سريريًا.</li>)}</ul>}
    </section>
  </section>;
}
