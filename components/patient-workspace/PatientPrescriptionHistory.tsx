"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { INSTRUCTIONS_LANG_LABEL } from "@/lib/prescription";
import { prescriptionIdentity, readPatientPrescriptionHistory, savedPrescriptionIssuedAt, savedPrescriptionPrintHref, type SavedPrescription } from "@/lib/patient-prescription-history";
import styles from "./workspace.module.css";

interface HistoryProps {
  patientId: number;
  authorityKey: string;
  canRead: boolean;
  active: boolean;
  readable: boolean;
  readRevision: number;
  prescriptionDialogOpen?: boolean;
}
type Status = "loading" | "ready" | "denied" | "error" | "waiting" | "inactive" | "paused";
interface ReadState {
  scope: object | null;
  generation: number;
  status: Status;
  rows: SavedPrescription[] | null;
}
const EMPTY: ReadState = { scope: null, generation: 0, status: "loading", rows: null };

/** Independent reader: never touches the editor draft, suggestions or save outcome. */
export function usePatientPrescriptionHistory({ patientId, authorityKey, canRead, active, readable, readRevision, prescriptionDialogOpen = false }: HistoryProps) {
  const key = JSON.stringify([patientId, authorityKey, canRead, active, readable, readRevision, prescriptionDialogOpen]);
  const scope = useMemo(() => ({ key }), [key]);
  const owner = useRef<typeof scope | null>(null);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<ReadState>(EMPTY);
  const blocked: Status | null = !active ? "inactive" : !canRead ? "denied" : prescriptionDialogOpen ? "paused" : !readable ? "waiting" : null;

  // Commit-time revocation, including A → B → A, precedes passive effects/events.
  // Speculative renders must not revoke the still-committed UI.
  useLayoutEffect(() => {
    owner.current = scope;
    const revisions = sequence, pending = request;
    return () => { owner.current = null; ++revisions.current; pending.current?.abort(); };
  }, [scope]);

  const reload = useCallback(async () => {
    if (owner.current !== scope) return;
    const generation = ++sequence.current;
    request.current?.abort();
    if (blocked) { setState({ scope, generation, status: blocked, rows: null }); return; }
    if (!prescriptionIdentity(patientId) || !authorityKey.trim()) {
      setState({ scope, generation, status: "error", rows: null }); return;
    }
    const controller = new AbortController(); request.current = controller;
    const current = () => owner.current === scope && sequence.current === generation && !controller.signal.aborted;
    setState({ scope, generation, status: "loading", rows: null });
    try {
      const response = await fetch(`/api/patients/${patientId}/prescriptions`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if ([401, 403, 404].includes(response.status)) {
        setState({ scope, generation, status: "denied", rows: null }); return;
      }
      if (!response.ok) { setState({ scope, generation, status: "error", rows: null }); return; }
      const payload: unknown = await response.json();
      if (!current()) return;
      const rows = readPatientPrescriptionHistory(payload, patientId);
      setState({ scope, generation, status: "ready", rows });
    } catch {
      if (current()) setState({ scope, generation, status: "error", rows: null });
    }
  }, [authorityKey, blocked, patientId, scope]);
  useEffect(() => { void reload(); }, [reload]);
  const current = blocked ? { ...EMPTY, status: blocked }
    : state.scope === scope ? state : EMPTY;
  const isCurrent = useCallback((generation: number) => !blocked && owner.current === scope
    && sequence.current === generation && !request.current?.signal.aborted, [blocked, scope]);
  return { ...current, reload, isCurrent };
}

/** Saved originals only. Active means the document is not void, not a current regimen. */
export function PatientPrescriptionHistory(props: HistoryProps) {
  const history = usePatientPrescriptionHistory(props);
  if (!props.active) return null;
  const guardPrint = (event: MouseEvent<HTMLAnchorElement>) => {
    if (history.status !== "ready" || !history.isCurrent(history.generation)) event.preventDefault();
  };
  return <section className={styles.panel} dir="rtl" aria-label="الوصفات المحفوظة" data-testid="patient-prescription-history">
    <div className={styles.panelHeading}>
      <div><h3 className={styles.panelTitle}>الوصفات المحفوظة</h3><p className={styles.muted}>أحدث ما يصل إلى 50 وصفة، وليس كامل التاريخ أو إجمالي وصفات المريض</p></div>
      <button type="button" className={styles.button} data-testid="prescription-history-refresh" onClick={() => void history.reload()}
        disabled={history.status === "loading" || !props.canRead || !props.readable || props.prescriptionDialogOpen}>تحديث الوصفات</button>
    </div>
    {history.status === "loading" ? <p role="status" data-testid="prescription-history-loading">جارٍ تحميل الوصفات المحفوظة…</p> : null}
    {history.status === "waiting" ? <p role="status" data-testid="prescription-history-waiting">عرض الوصفات متوقف حتى يكتمل التحقق من ملف المريض. أعد تحديث الملف إذا تعذّر التحقق.</p> : null}
    {history.status === "paused" ? <p role="status" data-testid="prescription-history-paused">سيُعاد تحميل السجل بعد إغلاق نموذج الوصفة. إغلاق النموذج لا يؤكد حفظ وصفة.</p> : null}
    {history.status === "denied" ? <p role="alert" data-testid="prescription-history-denied">الوصفات غير متاحة ضمن الوصول الحالي. أُخفيت البيانات والروابط السابقة.</p> : null}
    {history.status === "error" ? <p role="alert" data-testid="prescription-history-error">تعذّر التحقق من الوصفات المحفوظة. هذا لا يعني عدم وجود وصفات؛ أعد المحاولة.</p> : null}
    {history.status === "ready" && history.rows?.length === 0 ? <p role="status" data-testid="prescription-history-empty">لا توجد وصفات محفوظة في القراءة الحالية.</p> : null}
    {history.status === "ready" && history.rows && history.rows.length > 0 ? <div className={styles.stack}>
      <p className={styles.muted}>«غير مبطلة» هي حالة الوثيقة المحفوظة، وليست توصية باستخدام الدواء الآن. هذه القراءة لا تحسم نتيجة حفظ غير مؤكدة في النموذج.</p>
      {history.rows.map((row) => {
        const href = savedPrescriptionPrintHref(props.patientId, row);
        return <article key={`${history.generation}:${row.id}`} className={styles.disclosure} data-testid={`saved-prescription-${row.id}`}>
          <div className="space-y-2 p-4">
            <div className={styles.actions}><h4 className="font-bold">وصفة #{row.id}</h4><span className={styles.statusPill}>{row.status === "void" ? "مبطلة" : "غير مبطلة"}</span></div>
            <p className={styles.muted}>تاريخ الإصدار: <time dateTime={row.createdAt} dir="ltr">{savedPrescriptionIssuedAt(row.createdAt)}</time></p>
            <p className={styles.muted}>اسم مستخدم المُصدر: <bdi>{row.createdBy.trim() ? row.createdBy : "غير مسجل"}</bdi></p>
            <p className={styles.muted}>{row.visitId === null ? "دون ارتباط بزيارة" : <>الزيارة المحفوظة: <bdi>#{row.visitId}</bdi></>} · عدد الأدوية: {row.items.length}</p>
            <p className="whitespace-pre-wrap text-sm">التشخيص المحفوظ: {row.diagnosis || "غير مسجل"}</p>
            {row.status === "void" ? <p className="whitespace-pre-wrap text-sm text-rose-800">سبب الإبطال: {row.voidReason || "غير مسجل"}</p> : null}
            {href ? <a href={href} target="_blank" rel="noopener noreferrer" className={styles.button} data-testid={`prescription-print-${row.id}`} onClick={guardPrint} onAuxClick={guardPrint}>عرض وطباعة الأصل المحفوظ</a> : null}
          </div>
          <details className="border-t border-slate-200 p-4">
            <summary className="min-h-11 cursor-pointer font-bold">تفاصيل الوصفة المحفوظة #{row.id}</summary>
            <p className={styles.muted}>لغة التعليمات: {INSTRUCTIONS_LANG_LABEL[row.instructionsLang]}</p>
            <p className="whitespace-pre-wrap text-sm">ملاحظات الإصدار: {row.notes || "غير مسجلة"}</p>
            {row.items.length === 0 ? <p className={styles.muted}>لا توجد أدوية قابلة للعرض في القراءة المحفوظة الحالية.</p> : null}
            {row.status === "void" ? <p className={styles.muted}>اسم مستخدم الإبطال: <bdi>{row.voidedBy || "غير مسجل"}</bdi> · تاريخ الإبطال: {row.voidedAt ? <time dateTime={row.voidedAt} dir="ltr">{savedPrescriptionIssuedAt(row.voidedAt)}</time> : "غير مسجل"}</p> : null}
            <ol className="mt-3 list-inside list-decimal space-y-3">
              {row.items.map((item, index) => <li key={index} className="rounded-xl bg-slate-50 p-3">
                <bdi className="font-bold">{item.name}</bdi>
                <dl className="mt-2 grid gap-1 text-sm">
                  <div><dt className="inline">العيار: </dt><dd className="inline whitespace-pre-wrap"><bdi>{item.dose || "غير مسجل"}</bdi></dd></div>
                  <div><dt className="inline">الشكل: </dt><dd className="inline whitespace-pre-wrap"><bdi>{item.form || "غير مسجل"}</bdi></dd></div>
                  <div><dt className="inline">التكرار: </dt><dd className="inline whitespace-pre-wrap"><bdi>{item.frequency || "غير مسجل"}</bdi></dd></div>
                  <div><dt className="inline">المدة: </dt><dd className="inline whitespace-pre-wrap"><bdi>{item.duration || "غير مسجلة"}</bdi></dd></div>
                  <div><dt className="inline">التعليمات بالعربية: </dt><dd className="inline whitespace-pre-wrap">{item.instructions || "غير مسجلة"}</dd></div>
                  <div><dt className="inline">التعليمات بالإنجليزية: </dt><dd className="inline whitespace-pre-wrap"><bdi>{item.instructionsEn || "غير مسجلة"}</bdi></dd></div>
                </dl>
              </li>)}
            </ol>
          </details>
        </article>;
      })}
    </div> : null}
  </section>;
}
