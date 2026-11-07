"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FacialRead, FacialRevision } from "@/lib/ortho-facial-records";
import type { FacialHistoryPage } from "@/lib/ortho-facial-history";
import { fetchFacialHistoryPage } from "@/lib/ortho-facial-history-client";
import { OrthoFacialSavedRevision } from "./OrthoFacialSavedRevision";
const control = "min-h-11 rounded-lg border px-3 py-2 text-sm disabled:opacity-50";
type View = { token: object; phase: "loading" | "ready" | "error"; anchor: FacialRevision; page: FacialHistoryPage | null };

/** Read-only page window. Never changes the current editor's head, draft or canvas. */
export function OrthoFacialOlderHistory({ data, readIdentity, active, onDenied }: {
  data: FacialRead; readIdentity: object; active: () => boolean; onDenied: () => void;
}) {
  const token = useMemo(() => ({ data, readIdentity }), [data, readIdentity]);
  const committed = useRef<object | null>(null);
  const operation = useRef({ sequence: 0, busy: false, controller: null as AbortController | null });
  const [stored, setStored] = useState<View | null>(null);
  const view = stored?.token === token ? stored : null;
  const shown = useRef<View | null>(null);
  useLayoutEffect(() => {
    committed.current = token;
    const op = operation.current;
    return () => { if (committed.current === token) committed.current = null; op.sequence++; op.busy = false; op.controller?.abort(); shown.current = null; };
  }, [token]);
  useLayoutEffect(() => { shown.current = view; }, [view]);
  const renderedSequence = operation.current.sequence;
  const current = () => committed.current === token && active();
  const currentAction = () => current() && operation.current.sequence === renderedSequence && shown.current === view;
  const initial = data.history.at(-1);
  const eligible = data.historyTruncated && data.selectedDocumentId !== null && data.image !== null && initial && initial.version > 1;
  async function request(anchor: FacialRevision) {
    const op = operation.current;
    if (!eligible || !currentAction() || op.busy) return;
    op.busy = true; const sequence = ++op.sequence, controller = new AbortController(); op.controller = controller;
    const owned = () => current() && op.sequence === sequence;
    const loading: View = { token, phase: "loading", anchor, page: null }; shown.current = loading; setStored(loading);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        cancel = () => reject(Error("facial_history_cancelled")); controller.signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(Error("facial_history_timeout")); }, 15_000);
      });
      const page = await Promise.race([fetchFacialHistoryPage({ patientId: data.patientId, orthoCaseId: data.orthoCaseId,
        clinicalCaseId: data.clinicalCaseId, actorId: data.actorId, documentId: data.selectedDocumentId!, anchor }, controller.signal, () => { if (owned()) onDenied(); }), timeout]);
      if (owned() && !controller.signal.aborted) { const ready: View = { token, phase: "ready", anchor, page }; shown.current = ready; setStored(ready); }
    } catch {
      if (owned()) { const failed: View = { token, phase: "error", anchor, page: null }; shown.current = failed; setStored(failed); }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancel) controller.signal.removeEventListener("abort", cancel);
      if (op.sequence === sequence) { op.busy = false; op.controller = null; }
    }
  }
  function close() {
    if (!currentAction()) return;
    const op = operation.current; op.sequence++; op.busy = false; op.controller?.abort(); op.controller = null;
    shown.current = null; setStored(null);
  }
  if (!eligible || !active()) return null;
  return <section aria-label="المراجعات الأقدم للصورة، للقراءة فقط" className="space-y-3 rounded-xl border border-slate-300 p-3" data-testid="facial-older-history">
    <h2 className="font-bold">مراجعات أقدم للصورة، للقراءة فقط</h2>
    <p className="text-xs">تُعرض صفحة واحدة في كل مرة. لا تغيّر القراءة النسخة الحالية أو المسودة أو معالم اللوحة، ولا تنقل القياسات بين الصور.</p>
    {!view ? <button type="button" className={control} onClick={() => void request(initial)}>عرض المراجعات الأقدم</button> : <>
      <button type="button" className={control} onClick={close}>إغلاق المراجعات الأقدم</button>
      <p className="text-xs">الأقدم من المراجعة #{view.anchor.id} · نسخة {view.anchor.version}</p>
      {view.phase === "loading" && <p role="status">جارٍ التحقق من صفحة السجل ومصدر الصورة…</p>}
      {view.phase === "error" && <div role="alert"><p>تعذّر التحقق من الصفحة؛ لم تُعرض صفحة قديمة بدلاً منها. قد يكون المصدر أو الوصول قد تغيّر. حدّث سجل الصورة للتحقق.</p><button type="button" className={control} onClick={() => void request(view.anchor)}>إعادة قراءة هذه الصفحة</button></div>}
      {view.phase === "ready" && view.page && <>
        <p className="text-xs">المصدر المسجّل للصورة #{view.page.documentId}؛ وقت تسجيل المراجعة منفصل عن تاريخ الصورة الموثّق. سلامة البصمات ليست اعتمادًا سريريًا مستقلًا.</p>
        {view.page.history.map(revision => <OrthoFacialSavedRevision key={revision.id} revision={revision} />)}
        {view.page.hasMore ? <button type="button" className={control} onClick={() => { const anchor = view.page?.history.at(-1); if (anchor) void request(anchor); }}>عرض الصفحة الأقدم التالية</button>
          : <p role="status">وصلت القراءة إلى أول نسخة مسجّلة لهذه الصورة.</p>}
      </>}
    </>}
  </section>;
}
