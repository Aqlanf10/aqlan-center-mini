"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import type { PatientWorkspaceFile } from "./usePatientWorkspace";
import styles from "./workspace.module.css";

const inFlightPatients = new Set<number>();
// These fences survive component ownership changes, not a full page reload.
const unresolvedPatients = new Set<number>();
const writeObservers = new Map<number, Set<() => void>>();
const notifyWrite = (patientId: number) => writeObservers.get(patientId)?.forEach((notify) => notify());
const definitiveRejection = (status: number) => status >= 400 && status < 500 && ![408, 499].includes(status);

/** NEW RECONSTRUCTION. Existing server guards/typed confirmations remain authoritative. No operation runs on mount. */
export function PatientAdministration({ file, onError }: { file: PatientWorkspaceFile; onError: (message: string | null) => void }) {
  const session = useSession();
  if (!isAdmin(session?.role)) return null;
  return <AdministrationDraft key={`${file.patient.id}:${session?.username}`} file={file} onError={onError} />;
}
function AdministrationDraft({ file, onError }: { file: PatientWorkspaceFile; onError: (message: string | null) => void }) {
  const { patient } = file;
  const router = useRouter();
  const [mode, setMode] = useState<"merge" | "delete" | null>(null);
  const [duplicate, setDuplicate] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(() => inFlightPatients.has(patient.id));
  const [uncertain, setUncertain] = useState(() => unresolvedPatients.has(patient.id));
  const [message, setMessage] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState(() => ({}));
  const activeDraftToken = useRef(draftToken);
  const mounted = useRef(false); const writing = useRef(false); const completed = useRef(false);
  // Layout cleanup retires this owner before any queued response can navigate.
  useLayoutEffect(() => {
    mounted.current = true;
    const notify = () => { setBusy(inFlightPatients.has(patient.id)); setUncertain(unresolvedPatients.has(patient.id)); };
    const observers = writeObservers.get(patient.id) ?? new Set<() => void>();
    observers.add(notify); writeObservers.set(patient.id, observers);
    const guard = (event: BeforeUnloadEvent) => { if (inFlightPatients.has(patient.id) || unresolvedPatients.has(patient.id)) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => { mounted.current = false; observers.delete(notify); if (!observers.size) writeObservers.delete(patient.id); window.removeEventListener("beforeunload", guard); };
  }, [patient.id]);
  const ownsDraft = () => mounted.current && draftToken === activeDraftToken.current;
  const blocked = () => !ownsDraft() || writing.current || inFlightPatients.has(patient.id) || unresolvedPatients.has(patient.id);
  const choose = (value: typeof mode) => {
    if (blocked()) return;
    const token = {}; activeDraftToken.current = token; setDraftToken(token);
    completed.current = false;
    setMode(value); setDuplicate(""); setConfirmation(""); setReason(""); setMessage(null); onError(null);
  };
  const matches = mode === "delete" ? confirmation.trim() === patient.patientNumber
    : duplicate.trim().length > 0 && duplicate.trim().toUpperCase() !== patient.patientNumber.toUpperCase() && duplicate.trim().toUpperCase() === confirmation.trim().toUpperCase();
  const submit = async () => {
    if (!mode || !matches || blocked() || completed.current) return;
    const accepted = window.confirm(mode === "delete"
      ? `حذف الملف ${patient.patientNumber} نهائيًا إن أجاز الخادم ذلك؟ لا يمكن التراجع من هذه الشاشة.`
      : `نقل سجلات الملف ${duplicate.trim()} إلى ${patient.patientNumber} ثم حذف الملف المكرر؟ راجع هوية المريضين؛ لا يمكن التراجع من هذه الشاشة.`);
    if (!accepted || !ownsDraft()) return;
    const operation = mode;
    writing.current = true; inFlightPatients.add(patient.id); notifyWrite(patient.id); setMessage(null); onError(null);
    try {
      const response = await fetch(operation === "delete" ? `/api/patients/${patient.id}` : `/api/patients/${patient.id}/merge`, {
        method: operation === "delete" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(operation === "delete" ? { confirmPatientNumber: confirmation.trim(), reason: reason.trim() || null }
          : { duplicatePatientNumber: duplicate.trim(), confirmDuplicateNumber: confirmation.trim(), reason: reason.trim() || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok && definitiveRejection(response.status)) {
        if (ownsDraft()) onError(typeof payload?.message === "string" ? payload.message : "رُفضت العملية؛ راجع بيانات الطلب قبل أي محاولة جديدة.");
        return;
      }
      if (!response.ok || response.status < 200 || response.status >= 300 || typeof payload?.message !== "string" || !payload.message.trim()) {
        unresolvedPatients.add(patient.id); notifyWrite(patient.id);
        if (ownsDraft()) onError("تعذّر تأكيد نتيجة العملية؛ قد تكون اكتملت. راجع الملف وسجل التدقيق قبل أي محاولة جديدة.");
        return;
      }
      completed.current = true;
      if (!ownsDraft()) return;
      if (operation === "delete") router.push("/patients");
      else { setMessage(payload.message); setMode(null); router.refresh(); }
    } catch {
      unresolvedPatients.add(patient.id); notifyWrite(patient.id);
      if (ownsDraft()) onError("انقطع الاتصال وقد تكون العملية اكتملت. لا تُكررها قبل مراجعة الملف وسجل التدقيق.");
    } finally { inFlightPatients.delete(patient.id); writing.current = false; notifyWrite(patient.id); }
  };
  return <details className={styles.administration}><summary>إدارة الملف · للمدير</summary><div className={styles.stack}>
    <p className={styles.muted}>الدمج والحذف عمليتان دائمتان، ويُعيد الخادم التحقق من الصلاحية وسلامة السجلات عند التنفيذ.</p>
    <p className={styles.context}>المريض: {patient.fullName} · رقم الملف <bdi>{patient.patientNumber}</bdi> · المعرّف الداخلي <bdi>{patient.id}</bdi></p>
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    {uncertain ? <p className={styles.error} role="alert">توجد عملية غير مؤكّدة النتيجة. راجع الملف وسجل التدقيق؛ تكرار العملية متوقف في هذه الجلسة. إعادة تحميل الصفحة قد تزيل هذا التحذير لكنها لا تؤكد النتيجة ولا تجعل التكرار آمنًا.</p> : null}
    {!mode ? <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || uncertain} onClick={() => choose("merge")}>دمج ملف مكرر</button><button type="button" className={styles.dangerButton} disabled={busy || uncertain} onClick={() => choose("delete")}>مراجعة حذف ملف خاطئ</button></div> : <form className={styles.stack} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className={styles.error}>{mode === "delete" ? "الحذف متاح فقط إذا لم يحمل الملف أثرًا طبيًا أو ماليًا يمنع محوه. لا تستنتج قابلية الحذف من عدد الزيارات الظاهر، ولا يمكن التراجع من هذه الشاشة." : `الملف الباقي هو ${patient.patientNumber}. ينتقل السجل المسموح إلى هذا الملف ويُحذف المكرر؛ يرفض الخادم التعارض والأثر المالي المحمي.`}</div>
      <fieldset disabled={busy || uncertain} className={styles.formFields}><div className={styles.formGrid}>
        {mode === "merge" ? <label className={styles.field}><span>رقم الملف المكرر المراد دمجه</span><input dir="ltr" value={duplicate} onChange={(event) => { if (!blocked()) setDuplicate(event.target.value); }} autoComplete="off" /></label> : null}
        <label className={styles.field}><span>{mode === "delete" ? `اكتب رقم الملف ${patient.patientNumber} للتأكيد` : "أعد كتابة رقم الملف المكرر"}</span><input dir="ltr" value={confirmation} onChange={(event) => { if (!blocked()) setConfirmation(event.target.value); }} autoComplete="off" /></label>
        <label className={styles.field}><span>السبب (يُسجّل في التدقيق)</span><input value={reason} maxLength={300} onChange={(event) => { if (!blocked()) setReason(event.target.value); }} /></label>
      </div></fieldset>
      <div className={styles.actions}><button type="submit" className={styles.dangerButton} disabled={!matches || busy || uncertain}>{busy ? "جارٍ تأكيد النتيجة…" : mode === "delete" ? "تأكيد الحذف النهائي" : "تأكيد الدمج الدائم"}</button><button type="button" className={styles.button} disabled={busy || uncertain} onClick={() => choose(null)}>إلغاء</button></div>
    </form>}
  </div></details>;
}
