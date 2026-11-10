"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { canExportOrthoStudy } from "@/lib/ortho-study-export-access";
import { STUDY_EXPORT_ARCHIVE_LIMITS, STUDY_EXPORT_FAILURES, STUDY_EXPORT_FORMATS, type StudyExportCommand, type StudyExportFormat, type StudyExportJob } from "@/lib/ortho-study-export-archive-contract";

interface Props { patientId: number; orthoCaseId: number; revisionId: number; revisionHash: string }
const control = "min-h-11 rounded border px-3 py-2 disabled:opacity-50";
const states: Record<StudyExportJob["state"], string> = { queued: "بانتظار تشغيلك", running: "قيد تجهيز الملف", ready: "جاهز للتنزيل", failed: "تعذر تجهيز الملف", cancelled: "ملغى" };
const reservationNotices: Record<StudyExportJob["state"], string> = {
  queued: "حُفظ طلب التصدير. اضغط «تجهيز الملف» لتشغيله.",
  running: "الطلب قيد تجهيز الملف. حدّث الحالة لمراجعة النتيجة.",
  ready: "الملف جاهز؛ يمكنك تنزيله من القائمة.",
  failed: "تعذر تجهيز هذا الطلب. راجع السبب قبل إعادة المحاولة.",
  cancelled: "هذا الطلب ملغى. يمكنك إنشاء طلب جديد عند الحاجة.",
};
const failures: Record<string, string> = {
  render_failed: "تعذر تجهيز الملف؛ يمكنك إعادة المحاولة.", render_limit: "تجاوز العرض حجم التصدير المسموح. راجع محتوى النسخة المحفوظة.",
  storage_unavailable: "تخزين الملفات غير متاح حاليًا.", storage_failed: "تعذر حفظ ملف التصدير.", authority_changed: "تغيرت صلاحيات الوصول؛ حدّث الصفحة للتحقق.",
  lease_expired: "انتهت مهلة التشغيل؛ حدّث الحالة قبل إعادة المحاولة.", renderer_unavailable: "صيغة هذا الطلب غير متاحة للتشغيل حاليًا.",
};
const requestFailures = {
  study_export_renderer_unavailable: "صيغة تجهيز هذا الطلب قديمة؛ أنشئ طلب تصدير جديدًا للنسخة المحفوظة.",
  study_export_runtime_unavailable: "تجهيز ملفات التصدير غير متاح في بيئة التشغيل الحالية. يحتاج إعداد التشغيل إلى مراجعة المسؤول.",
  study_export_busy: "خدمة تجهيز الملفات مشغولة حاليًا. انتظر قليلًا ثم حدّث الحالة قبل إعادة المحاولة.",
  study_export_publication_unconfirmed: "لم يتأكد حفظ الملف النهائي. حدّث حالة الطلب قبل إعادة التجهيز؛ لا تنشئ طلبًا جديدًا.",
  study_export_failed: "تعذر تجهيز الملف. راجع حالة الطلب وسبب التعذر قبل إعادة المحاولة.",
} as const;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
/** Whitelist the public receipt; never render server paths, arbitrary messages or manifests. */
function receipt(raw: unknown, scope: Props): StudyExportJob {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_receipt");
  const job = raw as StudyExportJob;
  if (!positive(job.id) || job.revisionId !== scope.revisionId || job.revisionHash !== scope.revisionHash
    || !STUDY_EXPORT_FORMATS.includes(job.format) || !Object.hasOwn(states, job.state) || !positive(job.creatorId)
    || !Number.isSafeInteger(job.generation) || job.generation < 0 || !timestamp(job.createdAt) || !timestamp(job.updatedAt)
    || !(job.failureCode === null || STUDY_EXPORT_FAILURES.includes(job.failureCode))) throw Error("invalid_receipt");
  const artifact = job.artifact;
  if (artifact !== null && (!artifact || typeof artifact !== "object" || !hash(artifact.sha256) || !positive(artifact.sizeBytes)
    || artifact.sizeBytes > STUDY_EXPORT_ARCHIVE_LIMITS.bytes || !positive(artifact.pageCount)
    || artifact.pageCount > STUDY_EXPORT_ARCHIVE_LIMITS.pages || !timestamp(artifact.createdAt))) throw Error("invalid_receipt");
  if ((job.state === "ready") !== (artifact !== null)) throw Error("invalid_receipt");
  return { id: job.id, revisionId: job.revisionId, revisionHash: job.revisionHash, format: job.format, state: job.state,
    generation: job.generation, creatorId: job.creatorId, createdAt: job.createdAt, updatedAt: job.updatedAt, failureCode: job.failureCode,
    artifact: artifact ? { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, pageCount: artifact.pageCount, createdAt: artifact.createdAt } : null };
}
function mergeJobPages(previous: readonly StudyExportJob[], incoming: readonly StudyExportJob[]): StudyExportJob[] {
  const merged = new Map(previous.map(job => [job.id, job]));
  for (const job of incoming) {
    const existing = merged.get(job.id);
    if (existing && (existing.revisionId !== job.revisionId || existing.revisionHash !== job.revisionHash
      || existing.creatorId !== job.creatorId || existing.format !== job.format || existing.createdAt !== job.createdAt)) throw Error("invalid_receipt_identity");
    merged.set(job.id, job);
  }
  return [...merged.values()].sort((left, right) => right.id - left.id);
}

export function OrthoStudyExportArchive(props: Props) {
  const session = useSession();
  if (!canExportOrthoStudy(session) || !hash(props.revisionHash)) return null;
  // A changed identity, role or saved revision retires all in-flight response owners.
  const identity = `${session?.userId ?? "unknown"}:${session?.username}:${session?.role}:${JSON.stringify(session?.permissions ?? null)}`;
  return <ArchiveWorkspace key={`${identity}:${props.patientId}:${props.orthoCaseId}:${props.revisionId}:${props.revisionHash}`}
    {...props} actorId={session?.userId} />;
}

function ArchiveWorkspace(props: Props & { actorId?: number }) {
  const [open, setOpen] = useState(false), [jobs, setJobs] = useState<StudyExportJob[]>([]);
  const [format, setFormat] = useState<StudyExportFormat>("illustrated-pptx");
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [nextCursor, setNextCursor] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [denied, setDenied] = useState(false);
  const [pending, setPending] = useState<StudyExportCommand | null>(null);
  const mounted = useRef(false), lock = useRef<object | null>(null), controllers = useRef(new Set<AbortController>());
  const pendingRef = useRef<StudyExportCommand | null>(null);
  const jobsRef = useRef<StudyExportJob[]>([]), cursorRef = useRef<number | null>(null);
  const endpoint = `/api/ortho/${props.orthoCaseId}/case-study/exports`;
  useLayoutEffect(() => {
    const activeControllers = controllers.current;
    mounted.current = true;
    return () => { mounted.current = false; lock.current = null; for (const controller of activeControllers) controller.abort(); activeControllers.clear(); };
  }, []);
  const current = (token: object) => mounted.current && lock.current === token;
  const replaceJobs = (next: StudyExportJob[]) => { jobsRef.current = next; setJobs(next); };
  async function request(kind: "list" | "older" | "reserve" | "run", job?: StudyExportJob) {
    const reading = kind === "list" || kind === "older", after = kind === "older" ? cursorRef.current : null;
    if (!mounted.current || lock.current || denied || !reading && !positive(props.actorId) || kind === "older" && !positive(after)) return;
    if (kind === "run" && (!job || job.creatorId !== props.actorId || !["queued", "running", "failed"].includes(job.state))) return;
    const token = {}; lock.current = token; setBusy(true); setNotice(null);
    const controller = new AbortController(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), kind === "run" ? 90_000 : 20_000);
    let url = `${endpoint}?patientId=${props.patientId}&revisionId=${props.revisionId}`, body: unknown;
    if (kind === "older") url += `&after=${after}`;
    else if (kind === "reserve") {
      const command = pendingRef.current ?? { schemaVersion: 1 as const, clientRequestId: crypto.randomUUID(), revisionId: props.revisionId, revisionHash: props.revisionHash, format };
      pendingRef.current = command; setPending(command); url = endpoint; body = { patientId: props.patientId, command };
    } else if (kind === "run") { url = `${endpoint}/${job!.id}/run`; body = { patientId: props.patientId, expectedGeneration: job!.generation }; }
    try {
      const response = await fetch(url, { method: reading ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
        signal: controller.signal, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (!current(token)) return;
      if (response.status === 401 || response.status === 403) {
        setDenied(true); replaceJobs([]); setNotice("لم تعد صلاحية التصدير أو الوصول متاحة. حدّث الصفحة للتحقق من الجلسة."); return;
      }
      if (!response.ok) {
        const raw: unknown = await response.json(); if (!current(token)) return;
        const code = raw && typeof raw === "object" && !Array.isArray(raw) && "ok" in raw && raw.ok === false
          && "code" in raw && typeof raw.code === "string" && Object.hasOwn(requestFailures, raw.code)
          ? raw.code as keyof typeof requestFailures : null;
        if (code === "study_export_failed" && kind === "run" && raw && typeof raw === "object" && "job" in raw) {
          const row = receipt(raw.job, props);
          if (row.id !== job!.id || row.creatorId !== job!.creatorId || row.format !== job!.format
            || row.state !== "failed" || row.generation < job!.generation) throw Error("invalid_receipt");
          replaceJobs(mergeJobPages(jobsRef.current, [row]));
        }
        setNotice(code ? requestFailures[code] : response.status === 409
          ? "لم يكتمل الطلب. حدّث حالة الملفات قبل إعادة المحاولة."
          : "لم يتأكد الطلب. احتُفظ باختيارك؛ حدّث الحالة أو أعد نفس الطلب."); return;
      }
      const raw: unknown = await response.json(); if (!current(token)) return;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("ok" in raw) || raw.ok !== true) throw Error("invalid_response");
      if (reading) {
        if (!("jobs" in raw) || !Array.isArray(raw.jobs) || raw.jobs.length > STUDY_EXPORT_ARCHIVE_LIMITS.list || !("next" in raw)
          || !(raw.next === null || positive(raw.next))) throw Error("invalid_response");
        const rows = raw.jobs.map(value => receipt(value, props));
        if (rows.some((row, index) => index > 0 && row.id >= rows[index - 1].id || after !== null && row.id >= after)
          || raw.next !== (rows.length === STUDY_EXPORT_ARCHIVE_LIMITS.list ? rows.at(-1)!.id : null)) throw Error("invalid_response");
        const merged = mergeJobPages(jobsRef.current, rows);
        replaceJobs(kind === "older" ? merged : rows); setLoaded(true);
        cursorRef.current = raw.next; setNextCursor(raw.next);
      } else {
        if (!("job" in raw)) throw Error("invalid_response");
        const row = receipt(raw.job, props);
        if (kind === "reserve" && (row.creatorId !== props.actorId || row.format !== pendingRef.current?.format)
          || kind === "run" && row.id !== job!.id) throw Error("invalid_response");
        replaceJobs(mergeJobPages(jobsRef.current, [row]));
        if (kind === "reserve") { pendingRef.current = null; setPending(null); }
        setNotice(kind === "reserve" ? reservationNotices[row.state] : row.state === "ready" ? "حُفظ الملف وهو جاهز للتنزيل." : "حدّث الحالة لمراجعة نتيجة التشغيل.");
      }
    } catch { if (current(token)) setNotice("لم يتأكد الطلب. احتُفظ باختيارك؛ حدّث الحالة أو أعد نفس الطلب."); }
    finally { clearTimeout(timer); controllers.current.delete(controller); if (current(token)) { lock.current = null; setBusy(false); } }
  }
  return <details className="w-full rounded border p-3" onToggle={event => {
    setOpen(event.currentTarget.open);
    // Opening performs only a read; subsequent recovery is explicit.
    if (event.currentTarget.open && !loaded && !denied) void request("list");
  }}>
    <summary className="cursor-pointer font-semibold">ملفات التصدير المحفوظة</summary>
    {open && <div className="mt-3 space-y-3">
      <p>تصدير هذه النسخة المحفوظة فقط. يبدأ التجهيز عند ضغط الزر؛ لا يوجد تشغيل تلقائي في الخلفية.</p>
      {notice && <p role="status">{notice}</p>}
      {!denied && <>
        <button type="button" className={control} disabled={busy} onClick={() => void request("list")}>تحديث حالة الملفات</button>
        <div className="flex flex-wrap items-center gap-2">
          <label>نوع الملف <select aria-label="نوع ملف التصدير المحفوظ" className={control} value={format} disabled={busy || !!pending}
            onChange={event => setFormat(event.target.value as StudyExportFormat)}><option value="illustrated-pptx">PowerPoint مصور</option><option value="text-pptx">PowerPoint نصي</option></select></label>
          <button type="button" className={control} disabled={busy || !positive(props.actorId)} onClick={() => void request("reserve")}>{pending ? "التحقق بإعادة نفس طلب التصدير" : "حفظ طلب تصدير جديد"}</button>
        </div>
        {pending && <p>طلب الحفظ غير محسوم؛ إعادة المحاولة تستخدم الطلب نفسه لمنع التكرار.</p>}
        {!positive(props.actorId) && <p>حدّث الصفحة لإثبات هوية الجلسة قبل إنشاء طلب أو تشغيله.</p>}
        {loaded && jobs.length === 0 && <p>لا توجد ملفات محفوظة لهذه النسخة بعد.</p>}
        <ul className="space-y-2">{jobs.map(job => <li key={job.id} className="rounded border p-2">
          <p>{job.format === "text-pptx" ? "PowerPoint نصي" : "PowerPoint مصور"} · {states[job.state]}</p>
          <p className="text-xs">طلب رقم <bdi>{job.id}</bdi></p>
          <p className="text-xs">أُنشئ <time dateTime={job.createdAt} title={job.createdAt} dir="ltr" className="inline-block whitespace-nowrap tabular-nums">
            {new Date(job.createdAt).toISOString().slice(0, 16).replace("T", " · ")} UTC</time></p>
          {job.failureCode && <p>{failures[job.failureCode]}</p>}
          {job.state === "ready" && job.artifact && <a className={`${control} mt-2 inline-flex items-center`} href={`${endpoint}/${job.id}/download?patientId=${props.patientId}`}>تنزيل الملف المحفوظ · {job.artifact.pageCount} صفحات</a>}
          {job.creatorId === props.actorId && ["queued", "running", "failed"].includes(job.state) && <button type="button" className={control} disabled={busy}
            onClick={() => void request("run", job)}>{job.state === "queued" ? "تجهيز الملف" : "إعادة محاولة تجهيز الملف"}</button>}
        </li>)}</ul>
        {nextCursor !== null && <button type="button" className={control} disabled={busy} onClick={() => void request("older")}>عرض ملفات أقدم</button>}
      </>}
    </div>}
  </details>;
}
