"use client";
import { useLayoutEffect, useRef, useState } from "react";
import type { JourneyScope } from "@/lib/ortho-case-journey-records";
import type { StudyInventoryRead } from "@/lib/ortho-case-study-inventory-client";
import { hasRetentionNoStore } from "@/lib/ortho-retention-transport";
import { editRetentionDocumentIds, readRetentionDocumentPage, readRetentionDocumentResponseJSON,
  retentionDocumentIds, retentionDocumentInventoryURL, RETENTION_DOCUMENT_LIMIT } from "@/lib/ortho-retention-document-picker";

export interface RetentionDocumentEdit { ownerKey: string; expectedDocumentIds: number[]; documentIds: number[] }
export interface OrthoRetentionDocumentPickerProps extends JourneyScope {
  ownerIdentity: object; ownerKey: string; generation: number; readVersion: number;
  documentIds: readonly number[]; writable: boolean;
  isCurrent(): boolean;
  onChange(request: RetentionDocumentEdit): boolean;
  onDenied(): void;
  onRestricted(): void;
}
type Binding = Pick<OrthoRetentionDocumentPickerProps, "ownerIdentity" | "ownerKey" | "patientId" | "orthoCaseId" | "clinicalCaseId" | "generation" | "readVersion" | "writable">;
type Session = { binding: Binding; active: boolean; denied: boolean; restricted: boolean; request: AbortController | null; page: StudyInventoryRead | null };
type View = { session: Session; state: "loading" | "error" | "restricted" | "denied" }
  | { session: Session; state: "ready"; page: StudyInventoryRead; afterId: number | null };
const sameBinding = (a: Binding, b: Binding) => a.ownerIdentity === b.ownerIdentity && a.ownerKey === b.ownerKey
  && a.patientId === b.patientId && a.orthoCaseId === b.orthoCaseId && a.clinicalCaseId === b.clinicalCaseId
  && a.generation === b.generation && a.readVersion === b.readVersion && a.writable === b.writable;
const button = "min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-900 disabled:opacity-50";

/** Controlled draft references only. Reads are one explicit page at a time;
 * only the parent owns draft CAS, command identity and the eventual POST. */
export function OrthoRetentionDocumentPicker(props: OrthoRetentionDocumentPickerProps) {
  const session = useRef<Session | null>(null), committed = useRef<{ token: object; props: OrthoRetentionDocumentPickerProps } | null>(null);
  const [view, setView] = useState<View | null>(null), token = {};
  const ids: number[] | null = (() => {
    try { retentionDocumentInventoryURL(props, null); return retentionDocumentIds(props.documentIds); }
    catch { return null; } // Never replace malformed parent bytes.
  })();

  useLayoutEffect(() => {
    const binding: Binding = { ownerIdentity: props.ownerIdentity, ownerKey: props.ownerKey, patientId: props.patientId,
      orthoCaseId: props.orthoCaseId, clinicalCaseId: props.clinicalCaseId, generation: props.generation, readVersion: props.readVersion, writable: props.writable };
    const owned: Session = { binding, active: true, denied: false, restricted: false, request: null, page: null };
    session.current = owned;
    return () => {
      owned.active = false; owned.page = null; owned.request?.abort(); owned.request = null;
      if (session.current === owned) session.current = null;
    };
  }, [props.ownerIdentity, props.ownerKey, props.patientId, props.orthoCaseId, props.clinicalCaseId, props.generation, props.readVersion, props.writable]);
  useLayoutEffect(() => {
    const captured = { token, props }; committed.current = captured;
    return () => { if (committed.current === captured) committed.current = null; };
  }, [token, props]);

  // Read authority follows only the latest *committed* parent callback for this
  // exact owner/read generation, not an abandoned render's draft callback.
  const liveSession = (owned: Session): boolean => {
    const current = committed.current;
    return !!current && session.current === owned && owned.active && !owned.denied && current.props.writable
      && sameBinding(owned.binding, current.props) && current.props.isCurrent();
  };
  const handlerCurrent = (): Session | null => {
    const owned = session.current;
    return committed.current?.token === token && owned && sameBinding(owned.binding, props) && liveSession(owned) ? owned : null;
  };
  let readUsed = false, editUsed = false;
  const load = async (afterId: number | null) => {
    const owned = handlerCurrent();
    if (!owned || !ids || readUsed || owned.request) return;
    readUsed = true;
    const controller = new AbortController(); owned.request = controller; owned.page = null;
    const live = () => owned.request === controller && !controller.signal.aborted && liveSession(owned);
    setView({ session: owned, state: "loading" });
    const timer = setTimeout(() => {
      const report = live();
      if (owned.request === controller) { owned.request = null; owned.page = null; }
      controller.abort();
      if (report) setView({ session: owned, state: "error" });
    }, 20_000);
    const clearDeadline = () => clearTimeout(timer);
    controller.signal.addEventListener("abort", clearDeadline, { once: true });
    try {
      const response = await fetch(retentionDocumentInventoryURL(owned.binding, afterId), {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      if (!live()) return;
      if (response.status === 401 || response.status === 403) {
        const deny = committed.current!.props.onDenied;
        owned.denied = true; owned.page = null; owned.request = null; controller.abort();
        setView({ session: owned, state: "denied" }); deny(); return;
      }
      if (response.status !== 200 || response.redirected || !hasRetentionNoStore(response)) throw new Error("retention_document_read_unavailable");
      const raw = await readRetentionDocumentResponseJSON(response, controller.signal);
      if (!live()) return;
      const page = readRetentionDocumentPage(raw, owned.binding, afterId);
      // Keep this check after strict parsing, as well as after network/body IO.
      if (!live()) return;
      if (page.state === "restricted") {
        const restrict = committed.current!.props.onRestricted;
        owned.page = null; owned.restricted = true; setView({ session: owned, state: "restricted" });
        // The parent may retire source-bearing saved facts and reread them.
        // A successful restricted inventory is not a whole-account denial.
        restrict();
      }
      else { owned.page = page; owned.restricted = false; setView({ session: owned, state: "ready", page, afterId }); }
    } catch {
      if (live()) { owned.page = null; setView({ session: owned, state: "error" }); }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", clearDeadline);
      if (owned.request === controller) owned.request = null;
      controller.abort();
    }
  };
  // Projection uses only state-bound identity and its retirement marker. Ref
  // reads belong to committed handlers/effects, never render-time admission.
  const currentView = view && view.session.active && sameBinding(view.session.binding, props) ? view : null;
  const page = currentView?.state === "ready" && currentView.session.page === currentView.page && !currentView.session.restricted ? currentView.page : null;
  const edit = (action: { type: "add" | "remove"; id: number }) => {
    const owned = handlerCurrent();
    // Even removal of a retained historical ID needs this view's fresh read
    // admission. A new local session cannot revive previously restricted IDs.
    if (!owned || !ids || editUsed || owned.request || owned.restricted || !page || owned.page !== page) return;
    const next = editRetentionDocumentIds(ids, page, action); if (!next) return;
    editUsed = true;
    props.onChange({ ownerKey: props.ownerKey, expectedDocumentIds: [...ids], documentIds: next });
  };

  // Never reveal a cached page or retained draft references after a committed
  // permission loss. The parent's private draft itself is not changed.
  if (!props.writable || currentView?.state === "denied") return <p role="status" data-testid="retention-document-picker-unavailable">اختيار مستندات التثبيت غير متاح للصلاحية الحالية. لم تُغيّر مراجع المسودة.</p>;
  if (!ids) return <p role="alert">تعذّر التحقق من مراجع مستندات المسودة. لم تُستبدل بقائمة فارغة.</p>;
  // A retry/error is not evidence that a previously restricted scope became
  // available. Keep its privacy latch until an exact available page is verified.
  // If a parent draft changed while the result was completing, there is no
  // stale setState. Its next render can still see that this read has retired.
  const busy = currentView?.state === "loading" && currentView.session.request !== null;
  const failed = currentView?.state === "error" || currentView?.state === "loading" && !busy;
  const restricted = currentView?.session.restricted === true;
  return <fieldset dir="rtl" className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-3" aria-label="مستندات تدوين التثبيت" data-testid="ortho-retention-document-picker">
    <legend className="font-semibold">مراجع المستندات</legend>
    <p className="text-xs text-slate-600">المصدر يعرض المعرّف والإتاحة فقط. اختر المستند صراحةً؛ لا تُفترض صورة أو نتيجة سريرية من رقمه.</p>
    <button type="button" className={button} disabled={busy} onClick={() => void load(null)}>قراءة مستندات الحالة</button>
    {busy ? <p role="status">جارٍ التحقق من صفحة المستندات…</p> : null}
    {failed ? <p role="alert">تعذّر التحقق من صفحة المستندات. لم تُعتبر القائمة فارغة ولم تُحذف مراجع المسودة. أعد القراءة صراحةً.</p> : null}
    {restricted ? <p role="status">قراءة هذه المستندات مقيّدة بالصلاحية الحالية. لم تُحذف مراجع المسودة.</p> : page ? <>
      <p className="text-sm">المراجع المختارة في المسودة: {ids.length} من {RETENTION_DOCUMENT_LIMIT}.</p>
      <ul aria-label="مراجع المستندات المحتفظ بها" className="space-y-2">{ids.map(id => {
        const choice = page?.choices.find(row => row.id === id);
        return <li key={id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><span>المستند #{id} · {choice?.state === "available" ? "متاح في الصفحة الحالية"
          : choice?.state === "unavailable" ? "غير متاح للاختيار الحالي؛ المرجع محفوظ في المسودة" : "مرجع محفوظ؛ لم تُتحقق إتاحته في هذه الصفحة"}</span>
          <button type="button" className={button} disabled={busy} onClick={() => edit({ type: "remove", id })} aria-label={`إزالة مرجع المستند #${id}`}>إزالة المرجع صراحةً</button></li>;
      })}</ul>
      <ul aria-label="صفحة مستندات الحالة" className="space-y-2">{page.choices.map(choice => <li key={choice.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span>المستند #{choice.id} · {choice.state === "available" ? "متاح للاختيار" : "غير متاح للاختيار"}</span>
        <button type="button" className={button} disabled={choice.state !== "available" || !choice.selection || ids.includes(choice.id) || ids.length >= RETENTION_DOCUMENT_LIMIT || busy}
          aria-label={`إضافة المستند #${choice.id}`} onClick={() => edit({ type: "add", id: choice.id })}>{ids.includes(choice.id) ? "مختار في المسودة" : "إضافة المرجع"}</button>
      </li>)}</ul>
        {!page.choices.length ? <p className="text-sm">لا توجد مستندات في هذه الصفحة المتحقق منها. المراجع السابقة لم تُحذف.</p> : null}
        <button type="button" className={button} disabled={page.nextAfterId === null || busy} onClick={() => { if (page.nextAfterId !== null) void load(page.nextAfterId); }}>الصفحة التالية من المستندات</button>
    </> : !busy && !failed ? <p role="status">اقرأ صفحة مخوّلة من مستندات الحالة لإظهار مراجع المسودة وإتاحتها للتعديل. بقيت المراجع محفوظة دون تغيير.</p> : null}
  </fieldset>;
}
