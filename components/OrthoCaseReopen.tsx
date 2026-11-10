"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { CASE_STATUS_LABEL, PHASE_LABEL } from "@/lib/ortho";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { readOrthoReopenCommand, isReopenRequestId, type OrthoLifecycleSnapshot, type OrthoReopenCommand, type OrthoReopenRead, type OrthoReopenReceipt, type OrthoReopenTarget } from "@/lib/ortho-reopen-contract";
import type { JourneyScope } from "@/lib/ortho-case-journey-records";

export interface ReopenExpectation { scope: JourneyScope; actorId: number; command: OrthoReopenCommand }
export interface ReopenReview { scope: JourneyScope; actorId: number; current: OrthoLifecycleSnapshot }
export interface ReopenDraft {
  reason: string; target: OrthoReopenTarget | ""; review: ReopenReview | null;
  pending: ReopenExpectation | null; lastReceipt: OrthoReopenReceipt | null;
}
export interface ReopenOperation { current(): boolean; uncertain(): void; finish(): void }
export interface OrthoReopenLifetime {
  identity: object; read(): ReopenDraft; active(): boolean; editable(): boolean; busy: boolean;
  change(field: "reason" | "target", value: string): void;
  commit(values: Partial<ReopenDraft>): void;
  resolve(expected: ReopenExpectation, receipt: OrthoReopenReceipt | null): boolean;
  begin(retry: boolean): ReopenOperation | null;
  deny(): void;
}
interface Props { patientId: number; orthoCaseId: number; lifetime: OrthoReopenLifetime; onChanged(): void }
const control = "min-h-11 min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:opacity-50";
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const version = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const closed = (s: OrthoLifecycleSnapshot) => s.status === "completed" || s.status === "discontinued";
const compatible = (s: OrthoLifecycleSnapshot, target: ReopenDraft["target"]) => !!target && (s.phase === "assessment" ? s.status === "discontinued" && target === "assessment" : target === "active" || target === "retention");
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJourneyJSON(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
const stamp = (value: string) => <time dateTime={value} title={value} dir="ltr" className="inline-block max-w-full whitespace-normal break-words">{value.slice(0, 16).replace("T", " · ")} UTC</time>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_reopen_response");
  return value as Record<string, unknown>;
}
function snapshot(raw: unknown): OrthoLifecycleSnapshot {
  const r = object(raw);
  if (!version(r.version) || typeof r.status !== "string" || !Object.hasOwn(CASE_STATUS_LABEL, r.status)
    || typeof r.phase !== "string" || !Object.hasOwn(PHASE_LABEL, r.phase)
    || !(r.closedAt === null || timestamp(r.closedAt)) || !(r.closedBy === null || text(r.closedBy, 200))
    || !(r.closedNote === null || typeof r.closedNote === "string")) throw Error("invalid_reopen_snapshot");
  return { version: r.version, status: r.status as OrthoLifecycleSnapshot["status"], phase: r.phase as OrthoLifecycleSnapshot["phase"],
    closedAt: r.closedAt, closedBy: r.closedBy, closedNote: r.closedNote };
}
function receipt(raw: unknown): OrthoReopenReceipt {
  const r = object(raw), before = snapshot(r.before);
  if (!positive(r.id) || !isReopenRequestId(r.commandId) || typeof r.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.requestFingerprint)
    || !positive(r.actorId) || !text(r.createdBy, 200) || !timestamp(r.createdAt) || !text(r.reason, 500) || !r.reason.trim()
    || !closed(before) || r.afterVersion !== before.version + 1 || !["assessment", "active", "retention"].includes(String(r.targetStatus))
    || !compatible(before, r.targetStatus as OrthoReopenTarget)) throw Error("invalid_reopen_receipt");
  return { id: r.id, commandId: r.commandId, requestFingerprint: r.requestFingerprint, actorId: r.actorId,
    createdBy: r.createdBy, createdAt: r.createdAt, reason: r.reason, before, afterVersion: r.afterVersion as number, targetStatus: r.targetStatus as OrthoReopenTarget };
}
function readEnvelope(raw: unknown, props: Props, actorId: number, expected?: ReopenExpectation | null) {
  const r = object(raw), scope = object(r.scope);
  if (r.ok !== true || r.actorId !== actorId || scope.patientId !== props.patientId || scope.orthoCaseId !== props.orthoCaseId
    || !positive(scope.clinicalCaseId) || expected && canonicalJourneyJSON(scope) !== canonicalJourneyJSON(expected.scope)) throw Error("invalid_reopen_scope");
  return { raw: r, scope: scope as unknown as JourneyScope, actorId, current: snapshot(r.current) };
}
async function matchReceipt(row: OrthoReopenReceipt, expected: ReopenExpectation) {
  const command = expected.command;
  if (row.actorId !== expected.actorId || row.commandId !== command.clientRequestId || row.reason !== command.reason
    || row.before.version !== command.expectedLifecycleVersion || row.before.status !== command.expectedStatus || row.targetStatus !== command.targetStatus
    || row.requestFingerprint !== await hash(command)) throw Error("invalid_reopen_receipt_binding");
}
const refusals: Record<string, string> = {
  reopen_state_changed: "تغيرت حالة التقويم أو بيانات إغلاقها. حدّث القراءة ثم راجعها قبل إنشاء طلب جديد؛ بقي السبب والاختيار محفوظين.",
  reopen_target_incompatible: "الحالة المختارة لا تناسب بيانات التقويم الحالية. حدّث القراءة وراجع اختيارك.",
  another_ortho_case_open: "توجد حالة تقويم أخرى مفتوحة لهذا المريض. راجع الحالات قبل إعادة فتح هذه الحالة.",
  case_not_closed: "حالة التقويم ليست مغلقة في القراءة الحالية. حدّث الحالة للمراجعة.",
  request_key_conflict: "تعذر مطابقة الطلب المحفوظ. لا تبدأ طلبًا آخر قبل التحقق من نتيجة هذا الطلب.",
  case_scope_changed: "تغير ربط حالة التقويم. لم يُنقل الطلب إلى حالة بديلة؛ أعد التحقق من الحالة.",
  invalid_reopen_command: "راجع اختيار الحالة وسبب إعادة الفتح؛ لم يُقبل الطلب.",
};

export function OrthoCaseReopen(props: Props) {
  const session = useSession();
  if (!session || !["admin", "doctor"].includes(session.role) || !positive(session.userId)) return null;
  return <ReopenWorkspace key={`${props.patientId}:${props.orthoCaseId}:${session.userId}:${session.role}:${JSON.stringify(session.permissions ?? null)}`} {...props} actorId={session.userId} />;
}
function ReopenWorkspace(props: Props & { actorId: number }) {
  const { lifetime } = props, draft = lifetime.read();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<{ owner: object; value: OrthoReopenRead } | null>(null);
  const live = useRef(false), lock = useRef<object | null>(null), latest = useRef(props), controllers = useRef(new Set<AbortController>());
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => {
    live.current = true; const activeControllers = controllers.current;
    return () => { live.current = false; lock.current = null; activeControllers.forEach(controller => controller.abort()); activeControllers.clear(); };
  }, [lifetime.identity]);
  const current = (token: object) => live.current && lock.current === token && latest.current.lifetime.identity === lifetime.identity && lifetime.active();
  const read = view?.owner === lifetime.identity && lifetime.active() ? view.value : null;
  const reviewed = !!read && !!draft.review && canonicalJourneyJSON(draft.review) === canonicalJourneyJSON({ scope: read.scope, actorId: read.actorId, current: read.current });
  const editable = lifetime.editable() && !busy && !draft.pending;
  const endpoint = `/api/ortho/${props.orthoCaseId}/reopen`;

  async function load(after?: number) {
    if (!live.current || lock.current || lifetime.busy || !lifetime.active()) return;
    const token = {}; lock.current = token; setBusy(true); setNotice(null);
    const pending = lifetime.read().pending, controller = new AbortController(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const query = new URLSearchParams({ patientId: String(props.patientId) });
      if (pending) query.set("requestId", pending.command.clientRequestId);
      if (after !== undefined) query.set("after", String(after));
      const response = await fetch(`${endpoint}?${query}`, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
      if (!current(token)) return;
      if ([401, 403, 404].includes(response.status)) { lifetime.deny(); return; }
      if (response.status !== 200) throw Error("reopen_read_failed");
      const result = readEnvelope(await response.json(), props, props.actorId, pending); if (!current(token)) return;
      if (!Array.isArray(result.raw.history) || result.raw.history.length > 25 || !(result.raw.next === null || positive(result.raw.next))) throw Error("invalid_reopen_history");
      const history = result.raw.history.map(receipt);
      if (history.some((row, index) => index > 0 && row.id >= history[index - 1].id || after !== undefined && row.id >= after)
        || result.raw.next !== (history.length === 25 ? history.at(-1)!.id : null)) throw Error("invalid_reopen_history");
      const recovered = result.raw.receipt === null ? null : receipt(result.raw.receipt);
      if (recovered && (!pending || result.current.version < recovered.afterVersion)) throw Error("invalid_reopen_recovery");
      if (pending && recovered) await matchReceipt(recovered, pending);
      if (!current(token)) return;
      const previous = after === undefined ? [] : read?.history ?? [];
      const merged = [...new Map([...previous, ...history].map(row => [row.id, row])).values()].sort((a, b) => b.id - a.id);
      setView({ owner: lifetime.identity, value: { ok: true, scope: result.scope, actorId: result.actorId, current: result.current, history: merged, next: result.raw.next, receipt: recovered } });
      if (pending && recovered) {
        if (!lifetime.resolve(pending, recovered)) throw Error("reopen_recovery_changed");
        setNotice("عُثر على إيصال الطلب السابق. حالة التقويم الحالية معروضة بصورة مستقلة أدناه."); props.onChanged();
      } else if (pending) setNotice("لم يُعثر على إيصال لهذا الطلب حتى الآن؛ النتيجة غير مؤكدة. يمكنك إعادة الطلب نفسه للتحقق دون تغيير مضمونه.");
      else if (draft.review && canonicalJourneyJSON(draft.review.current) !== canonicalJourneyJSON(result.current)) setNotice("تغيرت بيانات حالة التقويم. بقي السبب والاختيار محفوظين؛ راجع الحالة الحالية مجددًا.");
    } catch { if (current(token)) setNotice("تعذرت قراءة حالة التقويم. بقيت مدخلاتك والطلب غير المحسوم محفوظة؛ أعد التحقق."); }
    finally { clearTimeout(timer); controllers.current.delete(controller); if (current(token)) { lock.current = null; setBusy(false); } }
  }

  async function save(retry: boolean) {
    if (!live.current || lock.current || !lifetime.active()) return;
    const state = lifetime.read(); let expected = state.pending;
    if (retry && !expected) return;
    if (!retry) {
      const reviewedNow = read && state.review && canonicalJourneyJSON(state.review) === canonicalJourneyJSON({ scope: read.scope, actorId: read.actorId, current: read.current });
      if (!read || !lifetime.editable() || state.pending || !reviewedNow || !closed(read.current) || !compatible(read.current, state.target)) {
        setNotice("اختر حالة التقويم المقصودة وراجع بيانات الإغلاق الحالية قبل الحفظ."); return;
      }
      try {
        expected = { scope: read.scope, actorId: props.actorId, command: readOrthoReopenCommand({ schemaVersion: 1, clientRequestId: crypto.randomUUID(),
          expectedLifecycleVersion: read.current.version, expectedStatus: read.current.status, targetStatus: state.target, reason: state.reason }) };
      } catch { setNotice("اكتب سببًا واضحًا لإعادة فتح حالة التقويم، بحد أقصى 500 حرف."); return; }
    }
    if (!expected || expected.actorId !== props.actorId || expected.scope.patientId !== props.patientId || expected.scope.orthoCaseId !== props.orthoCaseId) return;
    const operation = lifetime.begin(retry); if (!operation) return;
    const frozen = Object.freeze({ ...expected, scope: Object.freeze({ ...expected.scope }), command: Object.freeze({ ...expected.command }) });
    const token = {}; lock.current = token; setBusy(true); setNotice(null); lifetime.commit({ pending: frozen });
    const controller = new AbortController(); controllers.current.add(controller); const timer = setTimeout(() => controller.abort(), 20_000);
    let settled = false, confirmed = false;
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: frozen.scope.patientId, clinicalCaseId: frozen.scope.clinicalCaseId, command: frozen.command }) });
      if (!current(token) || !operation.current()) return;
      if ([401, 403, 404].includes(response.status)) { lifetime.deny(); return; }
      const raw: unknown = await response.json(); if (!current(token) || !operation.current()) return;
      if (!response.ok) {
        const error = object(raw), code = typeof error.code === "string" && Object.hasOwn(refusals, error.code) ? error.code : "";
        if (error.ok === false && ([409].includes(response.status) && ["reopen_state_changed", "reopen_target_incompatible", "another_ortho_case_open", "case_not_closed"].includes(code)
          || response.status === 400 && code === "invalid_reopen_command")) {
          settled = lifetime.resolve(frozen, null);
          if (["reopen_state_changed", "reopen_target_incompatible", "case_not_closed"].includes(code)) setView(null);
        }
        setNotice(code ? refusals[code] : "لم تتأكد نتيجة إعادة الفتح. احتُفظ بالطلب نفسه للتحقق؛ لا تبدأ طلبًا جديدًا."); return;
      }
      const result = readEnvelope(raw, props, props.actorId, frozen), saved = receipt(result.raw.receipt);
      if (![200, 201].includes(response.status) || typeof result.raw.replayed !== "boolean" || (response.status === 200) !== result.raw.replayed
        || result.current.version < saved.afterVersion) throw Error("invalid_reopen_save");
      await matchReceipt(saved, frozen); if (!current(token) || !operation.current()) return;
      settled = lifetime.resolve(frozen, saved);
      if (!settled) throw Error("reopen_recovery_changed");
      confirmed = true;
      setView({ owner: lifetime.identity, value: { ok: true, scope: result.scope, actorId: result.actorId, current: result.current,
        history: [saved, ...(read?.history ?? []).filter(row => row.id !== saved.id)].sort((a, b) => b.id - a.id), next: read?.next ?? null, receipt: saved } });
      setNotice(result.raw.replayed ? "هذا إيصال الطلب السابق؛ لا يعني أن حالة التقويم ما زالت مفتوحة. راجع الحالة الحالية أدناه." : "سُجلت إعادة فتح حالة التقويم. راجع الحالة الحالية أدناه.");
    } catch { if (current(token)) setNotice("لم تتأكد نتيجة إعادة الفتح. احتُفظ بالطلب نفسه للتحقق؛ لا تبدأ طلبًا جديدًا."); }
    finally {
      clearTimeout(timer); controllers.current.delete(controller);
      if (!settled) operation.uncertain(); operation.finish();
      if (current(token)) { lock.current = null; setBusy(false); if (confirmed) props.onChanged(); }
    }
  }
  return <details className="mt-3 rounded-lg border bg-white p-3 text-sm" onToggle={event => {
    setOpen(event.currentTarget.open); if (event.currentTarget.open && !read) void load();
  }}>
    <summary className="min-h-11 cursor-pointer py-2 font-semibold">حالة التقويم: الإغلاق وإعادة الفتح{draft.pending ? " — طلب يحتاج التحقق" : ""}</summary>
    {open && <div className="space-y-3">
      {notice && <p role="status">{notice}</p>}
      <button type="button" className={control} disabled={busy || lifetime.busy} onClick={() => void load()}>{draft.pending ? "التحقق من نتيجة الطلب وقراءة الحالة الحالية" : "تحديث حالة التقويم"}</button>
      {read && <section aria-label="حالة التقويم الحالية" className="rounded border p-3">
        <p>الحالة الحالية حسب آخر قراءة: <strong>{CASE_STATUS_LABEL[read.current.status]}</strong></p>
        <p>مرحلة العلاج المسجلة: {PHASE_LABEL[read.current.phase]}</p>
        {closed(read.current) && <><p>الإغلاق: {read.current.closedAt ? stamp(read.current.closedAt) : "تاريخ الإغلاق غير مسجل"}</p>
          <p>المسجّل: {read.current.closedBy ?? "غير مسجل"}</p><p className="whitespace-pre-wrap break-words">ملاحظة الإغلاق: {read.current.closedNote ?? "غير مسجلة"}</p></>}
      </section>}
      {read && closed(read.current) && !draft.pending && <fieldset className="space-y-3" disabled={!editable}>
        <legend className="font-semibold">إعادة فتح حالة التقويم نفسها</legend>
        <label className="block">الحالة المقصودة <select className={`${control} w-full`} aria-label="الحالة المقصودة لإعادة فتح التقويم" value={draft.target}
          onChange={event => { if (!lifetime.editable() || lifetime.read().pending) return; lifetime.change("target", event.target.value); lifetime.commit({ review: null }); }}>
          <option value="">اختر الحالة صراحة…</option>
          {read.current.phase === "assessment" ? <option value="assessment">تقييم الحالة</option> : <><option value="active">علاج نشط</option><option value="retention">متابعة التثبيت</option></>}
        </select></label>
        {draft.target && !compatible(read.current, draft.target) && <p role="status">الاختيار السابق «{CASE_STATUS_LABEL[draft.target]}» لا يناسب البيانات الحالية. اختر الحالة المقصودة من جديد.</p>}
        <label className="block">سبب إعادة فتح حالة التقويم (مطلوب)<textarea aria-label="سبب إعادة فتح حالة التقويم" aria-required="true" className={`${control} w-full`} rows={3} maxLength={500}
          value={draft.reason} onChange={event => lifetime.change("reason", event.target.value)} /></label>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={reviewed} onChange={event => {
          if (lifetime.editable() && !lifetime.read().pending) lifetime.commit({ review: event.target.checked ? { scope: read.scope, actorId: read.actorId, current: read.current } : null });
        }} />راجعت حالة التقويم وبيانات الإغلاق الحالية واخترت الحالة المقصودة</label>
        <p className="text-xs">تبقى مرحلة العلاج المسجلة كما هي. تعديل المرحلة قرار مستقل.</p>
        <button type="button" className={control} disabled={!editable || !reviewed || !compatible(read.current, draft.target)} onClick={() => void save(false)}>تأكيد إعادة فتح حالة التقويم</button>
      </fieldset>}
      {draft.pending && <section aria-label="طلب إعادة الفتح غير المحسوم" className="space-y-2 rounded border border-amber-300 p-3">
        <p>الحالة المطلوبة: {CASE_STATUS_LABEL[draft.pending.command.targetStatus]}</p><p className="whitespace-pre-wrap break-words">السبب المحفوظ: {draft.pending.command.reason}</p>
        <p>النتيجة غير مؤكدة حتى التحقق. إعادة المحاولة ترسل الطلب نفسه دون تعديل.</p>
        <button type="button" className={control} disabled={busy || lifetime.busy} onClick={() => void save(true)}>إعادة نفس طلب فتح حالة التقويم</button>
      </section>}
      {draft.lastReceipt && <p role="status">إيصال إعادة فتح محفوظ سابقًا: {CASE_STATUS_LABEL[draft.lastReceipt.targetStatus]}. هذا إيصال سابق، وليس إثباتًا للحالة الحالية؛ حدّث القراءة للتحقق.</p>}
      {read && <details><summary className="min-h-11 cursor-pointer py-2">سجل إعادة فتح حالة التقويم</summary>
        {read.history.length === 0 ? <p>لا توجد أحداث إعادة فتح مسجلة.</p> : <ol className="space-y-2">{read.history.map(row => <li key={row.id} className="rounded border p-2">
          <p>{CASE_STATUS_LABEL[row.before.status]} ← {CASE_STATUS_LABEL[row.targetStatus]}</p><p className="whitespace-pre-wrap break-words">{row.reason}</p>
          <p>{row.createdBy} · {stamp(row.createdAt)}</p>
          <p>الإغلاق السابق: {row.before.closedAt ? stamp(row.before.closedAt) : "تاريخه غير مسجل"} · {row.before.closedBy ?? "المسجّل غير معلوم"}</p>
          {row.before.closedNote !== null && <p className="whitespace-pre-wrap break-words">{row.before.closedNote}</p>}
        </li>)}</ol>}
        {read.next !== null && <button type="button" className={control} disabled={busy || lifetime.busy} onClick={() => void load(read.next!)}>عرض أحداث أقدم</button>}
      </details>}
    </div>}
  </details>;
}
