// Client-only child of a future authorized settings container; intentionally
// unmounted. Never pass the transport as a prop across a server/client boundary.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { completeNumberingDraft, createNumberingEditor, type OwnerNumberingPort } from '../../lib/patients/numbering-owner-editor';

export function OwnerPatientNumberingEditor({ port }: { port: OwnerNumberingPort | null }) {
  const editor = useMemo(() => createNumberingEditor(port), [port]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.serverSnapshot);
  useEffect(() => { void editor.read(); return editor.stop; }, [editor]);
  return <NumberingForm state={state} editor={editor} />;
}
type Editor = ReturnType<typeof createNumberingEditor>;
const control = 'block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2';
const button = 'rounded-xl border border-slate-300 px-3 py-2 disabled:opacity-50';
const primary = 'rounded-xl bg-navy-900 px-4 py-2 text-white disabled:opacity-50';

export function NumberingForm({ state, editor }: { state: ReturnType<Editor['snapshot']>; editor: Editor }) {
  if (state.kind === 'unavailable') return null;
  if (state.kind === 'loading') return <p dir="rtl" role="status">جارٍ قراءة إعداد الترقيم المعتمد…</p>;
  if (state.kind === 'read-failed') return <section dir="rtl" aria-label="ترقيم ملفات المرضى" className="space-y-3">
    <p role="status">تعذّرت قراءة الترقيم المعتمد.</p>
    <button className={button} type="button" onClick={() => void editor.read()}>إعادة القراءة</button>
  </section>;
  const notice = state.kind === 'previewing' ? 'بانتظار معاينة الخادم…'
    : state.kind === 'saving' ? 'بانتظار تأكيد الحفظ والتحقق من السجل…'
    : state.kind === 'uncertain' ? (state.checking ? 'جارٍ التحقق من الطلب نفسه…' : 'لم تتأكد نتيجة الحفظ. تحقّق من الطلب نفسه قبل أي تعديل آخر.')
    : state.kind === 'editing' ? ({
      none: '', saved: 'أكّد الخادم اعتماد الترقيم الجديد.', invalid: 'القيم غير مقبولة. عدّل الحقول واطلب معاينة جديدة.',
      repreview: 'لم يعتمد الخادم هذا الطلب. اطلب معاينة جديدة قبل المحاولة.',
      retired: 'أُغلق الطلب المنتهي دون حفظ. الحالة المعروضة من آخر قراءة للخادم.',
      'preview-failed': 'تعذّرت المعاينة. لم يتغيّر الترقيم المعتمد.',
    })[state.notice] : '';
  return <section dir="rtl" aria-label="ترقيم ملفات المرضى" className="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]">
    <h3 className="font-bold">ترقيم ملفات المرضى الجدد</h3>
    {state.active && <dl aria-label="آخر حالة معتمدة من الخادم" className="grid gap-1 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
      <dt>البادئة المعتمدة عند آخر قراءة</dt><dd><bdi dir="auto">{state.active.prefix}</bdi></dd>
      <dt>الرقم التالي عند آخر قراءة</dt><dd>{state.active.next === null ? 'لا توجد أرقام متاحة لهذه السلسلة' : <bdi dir="auto">{state.active.next}</bdi>}</dd>
    </dl>}
    <p className="text-sm">يخص التغيير الملفات الجديدة فقط. تبقى أرقام الملفات الصادرة كما هي.</p>
    {(state.kind === 'editing' || state.kind === 'previewing') && <form aria-label="طلب معاينة ترقيم الملفات" onSubmit={event => { event.preventDefault(); void editor.preview(); }}>
      <fieldset disabled={state.kind === 'previewing'} className="space-y-3">
        <legend className="font-semibold">مسودة الترقيم</legend>
        <label className="block">البادئة
          <input className={control} dir="auto" autoComplete="off" required value={state.draft.prefix} onChange={event => editor.edit('prefix', event.currentTarget.value)} />
        </label>
        <label className="block">أول رقم في السلسلة الجديدة
          <input className={control} dir="auto" autoComplete="off" inputMode="numeric" required value={state.draft.next} onChange={event => editor.edit('next', event.currentTarget.value)} />
        </label>
        <label className="block">سبب تغيير الترقيم
          <textarea className={control} dir="auto" rows={2} required value={state.draft.reason} onChange={event => editor.edit('reason', event.currentTarget.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className={primary} type="submit" disabled={state.kind !== 'editing' || !completeNumberingDraft(state.draft)}>اطلب معاينة من الخادم</button>
          <button type="button" className={button} onClick={editor.discard}>مسح المسودة</button>
        </div>
      </fieldset>
    </form>}
    {(state.kind === 'review' || state.kind === 'saving') && <section aria-label="مراجعة قبل الاعتماد" className="space-y-3 rounded-xl border border-sky-200 p-3">
      <h4 className="font-semibold">معاينة الخادم قبل الاعتماد</h4>
      <dl className="grid gap-1 text-sm sm:grid-cols-2">
        <dt>البادئة المقترحة</dt><dd><bdi dir="auto">{state.ticket.prefix}</bdi></dd>
        <dt>أول رقم مقترح</dt><dd><bdi dir="auto">{state.ticket.next}</bdi></dd>
        <dt>أول رقم ملف بصيغته المقترحة</dt><dd><bdi dir="auto">{state.ticket.preview}</bdi></dd>
        <dt>سبب التغيير</dt><dd><bdi dir="auto">{state.ticket.reason}</bdi></dd>
      </dl>
      <p className="text-sm">المعاينة لا تغيّر الترقيم المعتمد ولا تحجز رقمًا.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={state.kind !== 'review'} onClick={() => void editor.confirm(state.ticket)}>اعتماد الترقيم المعروض</button>
        <button type="button" className={button} disabled={state.kind !== 'review'} onClick={editor.discard}>العودة إلى التعديل</button>
      </div>
    </section>}
    {state.kind === 'uncertain' && <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={state.checking} onClick={() => void editor.verify()}>التحقق من نتيجة الحفظ</button>
      {state.canRetire && <button type="button" className={button} onClick={() => void editor.retire()}>إغلاق الطلب المنتهي دون اعتماد</button>}
    </div>}
    <p role="status">{notice}</p>
  </section>;
}
