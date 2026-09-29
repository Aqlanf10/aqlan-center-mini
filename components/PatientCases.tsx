"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CASE_STATUS_LABEL, CASE_TERMINAL, DEPENDENCY_REQUIREMENT_LABEL, PROBLEM_STATUS_LABEL, SPECIALTY_LABEL,
  type CaseStatus, type DependencyRequirement, type ProblemStatus,
} from "@/lib/cases";
import { SPECIALTIES, type ServiceSpecialty } from "@/lib/appointment-services";
import type { CasePlanItem, PatientProblem, PlanItemDependency, SpecialtyCase } from "@/lib/db";

/**
 * (CASE-MODEL-1) الحالات التخصصية وقائمة المشاكل وترتيب الخطة الشاملة — داخل «العلاج».
 *
 * مريضٌ واحد وسجلٌّ واحد وحالاتٌ كثيرة: كل حالة بتخصصها وطبيبها المسؤول وحالتها وبنودها،
 * والمشاكل النشطة أولًا، وبنود الخطة بأولويتها وما يتطلبه كلٌّ منها. الطبيب والمدير يكتبان؛
 * الاستقبال يطّلع. والمال لا يُمسّ هنا: الحساب واحد للمريض.
 */

interface Payload {
  cases: SpecialtyCase[];
  problems: PatientProblem[];
  items: CasePlanItem[];
  dependencies: PlanItemDependency[];
}

interface Doctor { id: number; name: string }

const STATUS_TONE: Record<CaseStatus, string> = {
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  waiting: "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-sky-50 text-sky-800 border-sky-200",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

const specialtyLabel = (value: string | null) =>
  value && value in SPECIALTY_LABEL ? SPECIALTY_LABEL[value as ServiceSpecialty] : value ?? "—";

export function PatientCases({ patientId, canWrite }: { patientId: number; canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caseForm, setCaseForm] = useState<{ specialty: ServiceSpecialty; title: string; site: string; problem: string; responsiblePartyId: string } | null>(null);
  const [problemForm, setProblemForm] = useState<{ label: string; site: string; specialty: string; caseId: string } | null>(null);
  const [closing, setClosing] = useState<{ id: number; status: CaseStatus; outcome: string } | null>(null);
  const [depForm, setDepForm] = useState<{ itemId: number; requiresItemId: string; requirement: DependencyRequirement } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as (Payload & { message?: string }) | null;
      if (!response.ok || !payload || !Array.isArray(payload.cases)) {
        setError(payload?.message ?? "تعذّر تحميل الحالات التخصصية.");
        return;
      }
      setData(payload);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canWrite) return;
    void fetch("/api/parties?kind=doctor", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((rows: unknown) => setDoctors(Array.isArray(rows) ? (rows as Doctor[]) : []))
      .catch(() => setDoctors([]));
  }, [canWrite]);

  /** كل كتابة: طلبٌ واحد، ورسالة الخادم العربية كما هي عند الرفض، ثم إعادة تحميل. */
  const send = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const itemsById = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const openCases = (data?.cases ?? []).filter((item) => item.id !== null && !CASE_TERMINAL.includes(item.status));
  const itemLabel = (item: CasePlanItem | undefined) =>
    item ? `${item.serviceName}${item.toothCode ? ` — سن ${item.toothCode}` : ""}` : "بند محذوف";

  if (!data) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{error ?? "جارٍ التحميل…"}</p>;
  }

  return (
    <div className="space-y-4" data-testid="patient-cases">
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">{error}</p> : null}

      {/* ── الحالات التخصصية ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="الحالات التخصصية">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">الحالات التخصصية</h3>
          {canWrite && !caseForm ? (
            <button type="button" onClick={() => setCaseForm({ specialty: "endodontics", title: "", site: "", problem: "", responsiblePartyId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ حالة جديدة</button>
          ) : null}
        </div>

        {caseForm ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">التخصص
              <select value={caseForm.specialty} onChange={(event) => setCaseForm({ ...caseForm, specialty: event.target.value as ServiceSpecialty })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                {SPECIALTIES.map((key) => <option key={key} value={key}>{SPECIALTY_LABEL[key]}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600">العنوان
              <input value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })}
                placeholder="علاج عصب — سن ٣٦" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الموضع (الأسنان / المنطقة)
              <input value={caseForm.site} onChange={(event) => setCaseForm({ ...caseForm, site: event.target.value })}
                placeholder="36" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الطبيب المسؤول
              <select value={caseForm.responsiblePartyId} onChange={(event) => setCaseForm({ ...caseForm, responsiblePartyId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                <option value="">—</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600 sm:col-span-2">المشكلة / التشخيص
              <textarea value={caseForm.problem} onChange={(event) => setCaseForm({ ...caseForm, problem: event.target.value })}
                rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" disabled={busy || !caseForm.title.trim()}
                onClick={async () => {
                  if (await send(`/api/patients/${patientId}/cases`, "POST", {
                    ...caseForm, responsiblePartyId: caseForm.responsiblePartyId || null,
                  })) setCaseForm(null);
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ الحالة</button>
              <button type="button" onClick={() => setCaseForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
        ) : null}

        {data.cases.length === 0 ? (
          <p className="text-xs text-slate-500">لا حالات تخصصية بعد. الخطة الشاملة وحدها تكفي لمريضٍ بتخصصٍ واحد.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.cases.map((item) => (
              <li key={item.id ?? `ortho-${item.orthoCaseId}`} className="rounded-xl border border-slate-200 p-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-extrabold text-navy-900">{item.title}{item.site ? ` · ${item.site}` : ""}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[item.status]}`}>{CASE_STATUS_LABEL[item.status]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {specialtyLabel(item.specialty)} · المسؤول: {item.responsibleName ?? "—"}
                  {item.itemsTotal > 0 ? ` · البنود ${item.itemsDone}/${item.itemsTotal}` : ""}
                </p>
                {item.problem ? <p className="mt-1 text-xs text-slate-500">{item.problem}</p> : null}
                {item.outcome ? <p className="mt-1 text-xs text-slate-500">النتيجة: {item.outcome}</p> : null}
                {item.kind === "ortho" ? (
                  <p className="mt-1 text-[11px] text-sky-700">تفاصيلها في «التقويم وسيفالو» — تُقرأ هنا ضمن حالات المريض.</p>
                ) : null}
                {canWrite && item.id !== null && !CASE_TERMINAL.includes(item.status) ? (
                  closing?.id === item.id ? (
                    <div className="mt-2 space-y-1">
                      <textarea value={closing.outcome} onChange={(event) => setClosing({ ...closing, outcome: event.target.value })}
                        rows={2} placeholder={closing.status === "cancelled" ? "سبب الإلغاء (مطلوب)" : "النتيجة (اختياري)"}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" disabled={busy || (closing.status === "cancelled" && !closing.outcome.trim())}
                          onClick={async () => {
                            if (await send(`/api/cases/${item.id}`, "PATCH", { status: closing.status, outcome: closing.outcome || null })) setClosing(null);
                          }}
                          className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">
                          تأكيد: {CASE_STATUS_LABEL[closing.status]}
                        </button>
                        <button type="button" onClick={() => setClosing(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.status === "active" ? (
                        <button type="button" disabled={busy} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "waiting" })}
                          className="rounded-lg border border-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-800">بانتظار</button>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "active" })}
                          className="rounded-lg border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-800">استئناف</button>
                      )}
                      {(["completed", "closed", "cancelled"] as CaseStatus[]).map((status) => (
                        <button key={status} type="button" onClick={() => setClosing({ id: item.id as number, status, outcome: "" })}
                          className="rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">{CASE_STATUS_LABEL[status]}</button>
                      ))}
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── قائمة المشاكل ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="قائمة المشاكل">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">قائمة المشاكل</h3>
          {canWrite && !problemForm ? (
            <button type="button" onClick={() => setProblemForm({ label: "", site: "", specialty: "", caseId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ مشكلة</button>
          ) : null}
        </div>
        {problemForm ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-4">
            <input value={problemForm.label} onChange={(event) => setProblemForm({ ...problemForm, label: event.target.value })}
              placeholder="التهاب لب غير عكوس" aria-label="المشكلة" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm sm:col-span-2" />
            <input value={problemForm.site} onChange={(event) => setProblemForm({ ...problemForm, site: event.target.value })}
              placeholder="36" aria-label="الموضع" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            <select value={problemForm.caseId} onChange={(event) => setProblemForm({ ...problemForm, caseId: event.target.value })}
              aria-label="الحالة" className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
              <option value="">بلا حالة</option>
              {openCases.map((item) => <option key={item.id} value={item.id as number}>{item.title}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-4">
              <button type="button" disabled={busy || !problemForm.label.trim()}
                onClick={async () => {
                  const linked = openCases.find((item) => String(item.id) === problemForm.caseId);
                  if (await send(`/api/patients/${patientId}/problems`, "POST", {
                    label: problemForm.label, site: problemForm.site || null,
                    specialty: linked?.specialty ?? null, caseId: problemForm.caseId || null,
                  })) setProblemForm(null);
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ</button>
              <button type="button" onClick={() => setProblemForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
        ) : null}
        {data.problems.length === 0 ? (
          <p className="text-xs text-slate-500">لا مشاكل مسجّلة.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.problems.map((problem) => (
              <li key={problem.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className={problem.status === "active" ? "font-bold text-slate-800" : "text-slate-400 line-through"}>
                  {problem.label}{problem.site ? ` · ${problem.site}` : ""}
                  {problem.caseTitle ? <span className="mr-1 text-[11px] text-slate-500">({problem.caseTitle})</span> : null}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">{PROBLEM_STATUS_LABEL[problem.status]}</span>
                  {canWrite ? (["active", "resolved", "inactive"] as ProblemStatus[])
                    .filter((status) => status !== problem.status)
                    .map((status) => (
                      <button key={status} type="button" disabled={busy}
                        onClick={() => void send(`/api/problems/${problem.id}`, "PATCH", { status })}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                        {status === "resolved" ? "حُلّت" : status === "inactive" ? "غير نشطة" : "إعادة تنشيط"}
                      </button>
                    )) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── ترتيب الخطة الشاملة وما يتطلبه كل بند ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="ترتيب الخطة الشاملة">
        <h3 className="mb-2 text-sm font-black text-navy-900">ترتيب الخطة الشاملة</h3>
        {data.items.length === 0 ? (
          <p className="text-xs text-slate-500">لا بنود خطة قائمة.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {data.items.map((item) => {
              const requires = data.dependencies.filter((dep) => dep.itemId === item.id);
              const blocked = requires.some((dep) => !dep.met) && item.status !== "done" && item.status !== "cancelled";
              return (
                <li key={item.id} className={`rounded-xl border p-2 ${blocked ? "border-amber-300 bg-amber-50/50" : "border-slate-200"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-slate-800">
                      {item.priority ? <span className="ml-1 rounded bg-navy-900 px-1.5 text-[10px] text-white">{item.priority}</span> : null}
                      {itemLabel(item)}
                      <span className="mr-1 text-[11px] font-normal text-slate-500">· {item.planTitle} · {item.doctorName ?? "—"} · {item.status === "done" ? "منفَّذ" : item.status === "in_progress" ? "قيد التنفيذ" : "مخطَّط"}</span>
                    </span>
                    {canWrite ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <select value={item.caseId ?? ""} disabled={busy} aria-label={`حالة ${item.serviceName}`}
                          onChange={(event) => void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: event.target.value || null, priority: item.priority })}
                          className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                          <option value="">بلا حالة</option>
                          {data.cases.filter((one) => one.id !== null).map((one) => <option key={one.id} value={one.id as number}>{one.title}</option>)}
                        </select>
                        <input type="number" min={1} max={999} defaultValue={item.priority ?? ""} aria-label={`أولوية ${item.serviceName}`}
                          onBlur={(event) => {
                            const value = event.target.value.trim();
                            if (value === String(item.priority ?? "")) return;
                            void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: item.caseId, priority: value || null });
                          }}
                          className="w-16 rounded-lg border border-slate-200 px-1.5 py-1 text-xs" placeholder="الأولوية" />
                        <button type="button" onClick={() => setDepForm({ itemId: item.id, requiresItemId: "", requirement: "completed" })}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">+ يتطلب</button>
                      </span>
                    ) : null}
                  </div>
                  {requires.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {requires.map((dep) => (
                        <li key={dep.requiresItemId} className={dep.met ? "text-emerald-700" : "text-amber-800"}>
                          {dep.met ? "✓" : "⚠️"} يتطلب: {itemLabel(itemsById.get(dep.requiresItemId))} ({DEPENDENCY_REQUIREMENT_LABEL[dep.requirement]})
                          {canWrite ? (
                            <button type="button" disabled={busy}
                              onClick={() => void send(`/api/plan-items/${item.id}/dependencies?requires=${dep.requiresItemId}`, "DELETE")}
                              className="mr-1 text-[10px] font-bold text-slate-500 underline">إزالة</button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {depForm?.itemId === item.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <select value={depForm.requiresItemId} aria-label="البند المطلوب قبله"
                        onChange={(event) => setDepForm({ ...depForm, requiresItemId: event.target.value })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="">اختر البند المطلوب قبله</option>
                        {data.items.filter((other) => other.id !== item.id).map((other) => (
                          <option key={other.id} value={other.id}>{itemLabel(other)}</option>
                        ))}
                      </select>
                      <select value={depForm.requirement} aria-label="نوع الاعتماد"
                        onChange={(event) => setDepForm({ ...depForm, requirement: event.target.value as DependencyRequirement })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="completed">{DEPENDENCY_REQUIREMENT_LABEL.completed}</option>
                        <option value="clearance">{DEPENDENCY_REQUIREMENT_LABEL.clearance}</option>
                      </select>
                      <button type="button" disabled={busy || !depForm.requiresItemId}
                        onClick={async () => {
                          if (await send(`/api/plan-items/${item.id}/dependencies`, "POST", {
                            requiresItemId: depForm.requiresItemId, requirement: depForm.requirement,
                          })) setDepForm(null);
                        }}
                        className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">حفظ</button>
                      <button type="button" onClick={() => setDepForm(null)} className="text-[11px] font-bold text-slate-500">إلغاء</button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
