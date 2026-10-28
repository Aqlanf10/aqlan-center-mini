"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { STAFF_CAPABILITIES, type StaffCapability, type StaffRecordScope } from "@/lib/staff-capability-catalogue";
import { STAFF_CAPABILITY_GROUPS, STAFF_CAPABILITY_LABELS, STAFF_SCOPE_LABELS, staffCapabilityGroup, toggleStaffCapability } from "@/lib/staff-capability-labels";

/**
 * صلاحيات الطاقم — الهوية الموحّدة.
 *
 * الدليل يُقرأ بقدرة staff.view، والمحرّر بقدرة staff.permissions.edit. الواجهة تعرض
 * ما يسمح به الخادم (editable/delegable/scopeOptions) ولا تقرّر شيئًا: الحفظ يمر
 * بمراجعة متوقّعة (CAS) وسياسة المنح كاملة في الخادم، وأي رفض يُعرض كما هو.
 */
interface DirectoryRow { id: number; username: string; role: string; isActive: boolean; clinicianPartyId: number | null }
interface TargetView {
  userId: number; username: string; displayName: string; roleLabel: string; isOwner: boolean; isSelf: boolean;
  revision: number; patientScope: StaffRecordScope; appointmentScope: StaffRecordScope;
  grants: StaffCapability[]; delegable: StaffCapability[]; editable: boolean;
  scopeOptions: { patient: StaffRecordScope[]; appointment: StaffRecordScope[] };
}
const roleLabel = (role: string) => ROLE_LABEL[role as Role] ?? role;

export default function StaffAccessPage() {
  const session = useSession();
  const canEdit = session?.isOwner === true || (session?.capabilities ?? []).includes("staff.permissions.edit");
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async (after: number | null) => {
    setLoading(true); setMessage("");
    try {
      const response = await fetch(`/api/staff-access${after ? `?after=${after}` : ""}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      if (!response.ok) { setMessage(body?.message ?? "تعذّر تحميل دليل الطاقم."); return; }
      setRows(previous => after ? [...previous, ...body.rows] : body.rows);
      setNext(body.nextAfterUserId ?? null);
    } catch { if (live.current) setMessage("تعذّر الاتصال بالخادم. أعد المحاولة."); }
    finally { if (live.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  return (
    <div dir="rtl" className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-black text-navy-900">صلاحيات الطاقم</h1>
          <p className="text-xs text-slate-600">كل تعديل يُحفظ بمراجعة جديدة ويُسجَّل في التدقيق، وتسقط جلسات الموظف القائمة فيدخل بصلاحياته الجديدة.</p>
        </div>
        <button type="button" onClick={() => void load(null)} disabled={loading}
          className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-navy-900 disabled:opacity-50">تحديث</button>
      </header>
      {message ? <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">{message}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <section aria-label="دليل الطاقم" className="rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
          <ul className="divide-y divide-slate-100" data-testid="staff-directory">
            {rows.map(row => (
              <li key={row.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-navy-900">{row.username}</p>
                  <p className="text-xs text-slate-600">
                    {roleLabel(row.role)}{row.clinicianPartyId ? " — مرتبط بطبيب" : ""}{row.isActive ? "" : " — غير نشط"}
                  </p>
                </div>
                {canEdit ? (
                  <button type="button" onClick={() => setSelected(row.id)} aria-pressed={selected === row.id}
                    className={`min-h-11 shrink-0 rounded-xl px-3 text-xs font-bold ${selected === row.id ? "bg-navy-900 text-white" : "border border-slate-300 text-navy-900"}`}>
                    الصلاحيات
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {!rows.length && !loading && !message ? <p className="p-3 text-sm text-slate-600">لا يوجد موظفون في الهوية الموحّدة.</p> : null}
          {loading ? <p role="status" className="p-2 text-xs text-slate-600">جارٍ التحميل…</p> : null}
          {next ? (
            <button type="button" onClick={() => void load(next)} disabled={loading}
              className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 text-sm font-semibold text-navy-900 disabled:opacity-50">تحميل المزيد</button>
          ) : null}
        </section>
        <section aria-label="محرّر الصلاحيات" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          {selected === null
            ? <p className="text-sm text-slate-600">{canEdit ? "اختر موظفًا لعرض صلاحياته." : "عرض الدليل فقط: تعديل الصلاحيات يحتاج صلاحية «إدارة صلاحيات الطاقم»."}</p>
            : <CapabilityEditor key={selected} userId={selected} />}
        </section>
      </div>
    </div>
  );
}

function CapabilityEditor({ userId }: { userId: number }) {
  const uid = useId();
  const [view, setView] = useState<TargetView | null>(null);
  const [grants, setGrants] = useState<Set<StaffCapability>>(new Set());
  const [patientScope, setPatientScope] = useState<StaffRecordScope>("none");
  const [appointmentScope, setAppointmentScope] = useState<StaffRecordScope>("none");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  function adopt(next: TargetView) {
    setView(next); setGrants(new Set(next.grants)); setPatientScope(next.patientScope); setAppointmentScope(next.appointmentScope);
  }
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/staff-access/${userId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      if (!response.ok) { setView(null); setError(body?.message ?? "تعذّر تحميل الصلاحيات."); return; }
      adopt(body);
    } catch { if (live.current) setError("تعذّر الاتصال بالخادم. أعد المحاولة."); }
    finally { if (live.current) setBusy(false); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!view || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/staff-access/${userId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: view.revision, patientScope, appointmentScope,
          grants: Object.fromEntries(STAFF_CAPABILITIES.filter(capability => grants.has(capability)).map(capability => [capability, true])) }),
      });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      if (!response.ok) {
        setError(body?.message ?? "تعذّر حفظ الصلاحيات.");
        if (response.status === 409) void load();
        return;
      }
      adopt(body);
      setMessage(`حُفظت الصلاحيات (المراجعة ${body.revision}). جلسات الموظف القائمة سقطت، ويدخل من جديد بصلاحياته الحالية.`);
    } catch { if (live.current) setError("تعذّر التحقق من الحفظ. حدّث البيانات قبل إعادة المحاولة."); }
    finally { if (live.current) setBusy(false); }
  }

  if (!view) return busy ? <p role="status" className="text-sm text-slate-600">جارٍ التحميل…</p> : <p role="alert" className="text-sm text-danger-800">{error}</p>;
  const delegable = new Set(view.delegable);
  const changed = view.patientScope !== patientScope || view.appointmentScope !== appointmentScope
    || view.grants.length !== grants.size || view.grants.some(capability => !grants.has(capability));
  return (
    <div className="space-y-3" data-testid="capability-editor">
      <div>
        <h2 className="text-base font-black text-navy-900">{view.displayName}</h2>
        <p className="text-xs text-slate-600">{view.username} — {roleLabel(view.roleLabel)} — المراجعة {view.revision}</p>
      </div>
      {view.isOwner ? <p role="note" className="rounded-xl bg-sky-50 p-2 text-xs text-sky-900">المالك المحمي يملك كل الصلاحيات، ولا تُعدَّل صلاحياته من هنا.</p>
        : view.isSelf ? <p role="note" className="rounded-xl bg-sky-50 p-2 text-xs text-sky-900">لا يمكنك تعديل صلاحياتك بنفسك.</p>
        : !view.editable ? <p role="note" className="rounded-xl bg-amber-50 p-2 text-xs text-amber-900">صلاحيات هذا الموظف تتجاوز ما يمكنك منحه، فلا تستطيع تعديلها.</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {([["patient", "نطاق المرضى", patientScope, setPatientScope], ["appointment", "نطاق المواعيد", appointmentScope, setAppointmentScope]] as const).map(([key, label, value, set]) => (
          <div key={key}>
            <label htmlFor={`${uid}-${key}`} className="block text-xs font-bold text-navy-900">{label}</label>
            <select id={`${uid}-${key}`} value={value} disabled={!view.editable || busy}
              onChange={event => set(event.target.value as StaffRecordScope)}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm">
              {(["none", "own", "all"] as const).map(scope => (
                <option key={scope} value={scope} disabled={scope !== value && !view.scopeOptions[key].includes(scope)}>{STAFF_SCOPE_LABELS[scope]}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {STAFF_CAPABILITY_GROUPS.map(group => {
        const items = STAFF_CAPABILITIES.filter(capability => staffCapabilityGroup(capability) === group.key);
        if (!items.length) return null;
        return (
          <fieldset key={group.key} className="rounded-xl border border-slate-200 p-2">
            <legend className="px-1 text-xs font-black text-navy-900">{group.label}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {items.map(capability => {
                const on = grants.has(capability);
                const allowed = view.editable && (on || delegable.has(capability));
                return (
                  <label key={capability} className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm ${allowed ? "text-navy-900" : "text-slate-400"}`}>
                    <input type="checkbox" checked={on} disabled={!allowed || busy}
                      onChange={event => setGrants(toggleStaffCapability(grants, capability, event.target.checked))} />
                    {STAFF_CAPABILITY_LABELS[capability]}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {error ? <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50 p-2 text-sm text-danger-800">{error}</p> : null}
      {message ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">{message}</p> : null}
      {view.editable ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void save()} disabled={busy || !changed}
            className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ الصلاحيات</button>
          <button type="button" onClick={() => adopt(view)} disabled={busy || !changed}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-navy-900 disabled:opacity-50">تراجع</button>
        </div>
      ) : null}
    </div>
  );
}
