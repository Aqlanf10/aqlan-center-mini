"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import {
  HR_CONTRACT_KIND_LABEL, HR_DEPARTMENT_LABEL, HR_SALARY_PERIOD_LABEL, HR_WORK_STATUS_LABEL,
  type HrContractKind, type HrDepartment, type HrSalaryPeriod, type HrWorkStatus,
} from "@/lib/hr-shared";

/**
 * لوحة الطاقم — المدير وحده (الخادم يحرسها والشاشة تعكس ذلك).
 *
 * فيها شروط الأجر بعملتها ودوريتها وتاريخ سريانها، والربط الاختياري بحسابٍ
 * موجود، وسجل تغييرات كل ملف. القائمة نفسها تُظهر المسمًّى والحالة — والمبالغ
 * لا تخرج من هنا إلى أي دليل إسناد.
 */

interface StaffView {
  id: number;
  fullName: string;
  jobTitle: string;
  department: HrDepartment;
  workStatus: HrWorkStatus;
  hireDate: string | null;
  endDate: string | null;
  contractKind: HrContractKind;
  payTerms: { amountMinor: number; currency: string; period: HrSalaryPeriod; effectiveOn: string } | null;
  userId: number | null;
  phone: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StaffDetail {
  staff: StaffView;
  changes: { id: number; actor: string; actorRole: string | null; action: string; field: string | null; oldValue: string | null; newValue: string | null; reason: string | null; createdAt: string }[];
  linkedUser: { id: number; username: string; displayName: string; role: string; isActive: boolean } | null;
}

interface AdminUserOption { id: number; username: string; displayName: string; role: string; linked: boolean }

// أرقام لاتينية بفواصل ثلاثية — عين أعمدة المبالغ في بقية البرنامج (formatAmount).
function fmtMoney(minor: number): string {
  return (minor / 100).toLocaleString("en", { maximumFractionDigits: 2 });
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(value));
}

const CONTRACT_ACTION_LABEL: Record<string, string> = {
  create: "إنشاء", update: "تعديل", pay_terms: "شروط الأجر", link_user: "ربط حساب", unlink_user: "فكّ حساب",
};

export function HrStaffPanel() {
  const [staff, setStaff] = useState<StaffView[]>([]);
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<"" | HrDepartment>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; detail: StaffDetail } | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (departmentFilter) params.set("department", departmentFilter);
      const response = await fetch(`/api/hr/staff?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر تحميل الطاقم.");
      }
      setStaff((await response.json()) as StaffView[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل الطاقم.");
    } finally {
      setLoading(false);
    }
  }, [search, departmentFilter]);

  useEffect(() => { void load(); }, [load]);

  const openEditor = async (id: number) => {
    const response = await fetch(`/api/hr/staff/${id}`, { cache: "no-store" });
    if (!response.ok) { setError("تعذّر فتح الملف."); return; }
    setEditor({ mode: "edit", detail: (await response.json()) as StaffDetail });
  };

  return (
    <section aria-label="ملفات الطاقم">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="ابحث بالاسم أو المسمّى…" aria-label="بحث في الطاقم"
          className="min-w-0 flex-1 rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm"
        />
        <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value as "" | HrDepartment)}
          aria-label="القسم" className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm">
          <option value="">كل الأقسام</option>
          {(Object.keys(HR_DEPARTMENT_LABEL) as HrDepartment[]).map((department) => (
            <option key={department} value={department}>{HR_DEPARTMENT_LABEL[department]}</option>
          ))}
        </select>
        <button onClick={() => setEditor({ mode: "create" })}
          className="rounded-xl bg-accent-500 px-4 py-2 text-sm font-bold text-white shadow-card hover:bg-accent-600">
          ملف موظف جديد
        </button>
      </div>

      {error && <p role="alert" className="mb-3 rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}

      {loading ? (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-navy-500 shadow-card">جارٍ التحميل…</p>
      ) : staff.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-navy-500 shadow-card">لا ملفات طاقم بعد.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card">
          <table className="w-full min-w-160 text-right text-sm">
            <thead>
              <tr className="border-b border-navy-100 text-xs text-navy-600">
                <th className="p-3 font-semibold">الاسم</th>
                <th className="p-3 font-semibold">المسمّى الوظيفي</th>
                <th className="p-3 font-semibold">القسم</th>
                <th className="p-3 font-semibold">حالة العمل</th>
                <th className="p-3 font-semibold">الالتحاق</th>
                <th className="p-3 font-semibold">نوع التعاقد</th>
                <th className="p-3 font-semibold">شروط الأجر</th>
                <th className="p-3 font-semibold">الحساب</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id} className="border-b border-navy-50 last:border-0 hover:bg-navy-50/50">
                  <td className="p-3">
                    <button onClick={() => void openEditor(member.id)} className="font-semibold text-brand-blue hover:underline">
                      {member.fullName}
                    </button>
                  </td>
                  <td className="p-3">{member.jobTitle || "—"}</td>
                  <td className="p-3">{HR_DEPARTMENT_LABEL[member.department]}</td>
                  <td className="p-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                      member.workStatus === "active" ? "bg-success-50 text-success-700"
                        : member.workStatus === "suspended" ? "bg-warning-50 text-warning-900"
                        : "bg-navy-100 text-navy-700"}`}>
                      {HR_WORK_STATUS_LABEL[member.workStatus]}
                    </span>
                  </td>
                  <td className="p-3 text-xs">{fmtDate(member.hireDate)}</td>
                  <td className="p-3 text-xs">{HR_CONTRACT_KIND_LABEL[member.contractKind]}</td>
                  <td className="p-3 text-xs">
                    {member.payTerms
                      ? <span className="ltr-nums">{fmtMoney(member.payTerms.amountMinor)} {member.payTerms.currency} — {HR_SALARY_PERIOD_LABEL[member.payTerms.period]}</span>
                      : "—"}
                  </td>
                  <td className="p-3 text-xs">{member.userId !== null ? "مرتبط" : "بلا حساب"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor?.mode === "create" && (
        <StaffEditorModal onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void load(); }} />
      )}
      {editor?.mode === "edit" && (
        <StaffEditorModal detail={editor.detail} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void load(); }} />
      )}
    </section>
  );
}

/** محرر ملف الموظف — إنشاء وتعديل في نموذجٍ واحد. */
function StaffEditorModal({ detail, onClose, onSaved }: {
  detail?: StaffDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = detail?.staff;
  const [fullName, setFullName] = useState(existing?.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle ?? "");
  const [department, setDepartment] = useState<HrDepartment>(existing?.department ?? "other");
  const [workStatus, setWorkStatus] = useState<HrWorkStatus>(existing?.workStatus ?? "active");
  const [hireDate, setHireDate] = useState(existing?.hireDate ?? "");
  const [endDate, setEndDate] = useState(existing?.endDate ?? "");
  const [contractKind, setContractKind] = useState<HrContractKind>(existing?.contractKind ?? "commission");
  const [hasPay, setHasPay] = useState(existing?.payTerms != null);
  const [amount, setAmount] = useState(existing?.payTerms ? String(existing.payTerms.amountMinor) : "");
  const [currency, setCurrency] = useState(existing?.payTerms?.currency ?? "YER");
  const [period, setPeriod] = useState<HrSalaryPeriod>(existing?.payTerms?.period ?? "monthly");
  const [effectiveOn, setEffectiveOn] = useState(existing?.payTerms?.effectiveOn ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [userOptions, setUserOptions] = useState<AdminUserOption[]>([]);
  const [linkUserId, setLinkUserId] = useState("");
  const [linkReason, setLinkReason] = useState("");

  useEffect(() => {
    if (!linkMode) return;
    void (async () => {
      const response = await fetch("/api/users", { cache: "no-store" });
      if (!response.ok) { setError("تعذّر تحميل حسابات المستخدمين."); return; }
      const users = (await response.json()) as { id: number; username: string; display_name: string; role: string }[];
      setUserOptions(users.map((user) => ({
        id: Number(user.id), username: user.username, displayName: user.display_name, role: user.role,
        linked: false,
      })));
    })();
  }, [linkMode]);

  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      fullName: fullName.trim(), jobTitle: jobTitle.trim(), department,
      hireDate: hireDate || null,
      endDate: endDate || null,
      contractKind,
      phone: phone.trim() || null, note: note.trim() || null,
    };
    if (!existing) body.workStatus = workStatus;
    if (contractKind !== "commission" && hasPay) {
      body.salaryAmountMinor = Number(amount);
      body.salaryCurrency = currency.trim().toUpperCase();
      body.salaryPeriod = period;
      body.salaryEffectiveOn = effectiveOn;
    }
    if (existing) body.reason = reason.trim() || undefined;
    return body;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(existing ? `/api/hr/staff/${existing.id}` : "/api/hr/staff", {
        method: existing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر الحفظ.");
      }
      onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "تعذّر الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  const submitLink = async (action: "link_user" | "unlink_user") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/hr/staff/${existing?.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, userId: Number(linkUserId), reason: linkReason.trim() }),
      });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر تنفيذ الربط.");
      }
      onSaved();
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "تعذّر تنفيذ الربط.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={existing ? `ملف ${existing.fullName}` : "ملف موظف جديد"} alignTop>
      <div className="mx-auto w-full max-w-2xl rounded-2xl bg-white p-5 shadow-raised">
        <h2 className="mb-4 text-lg font-bold text-navy-900">
          {existing ? `ملف: ${existing.fullName}` : "ملف موظف جديد"}
        </h2>

        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              الاسم الكامل
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              المسمّى الوظيفي — حرّ، لا يمنح أي صلاحية
              <input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} maxLength={80}
                placeholder="مثل: حارس، منسق مرضى، سكرتيرة…"
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              القسم
              <select value={department} onChange={(event) => setDepartment(event.target.value as HrDepartment)}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
                {(Object.keys(HR_DEPARTMENT_LABEL) as HrDepartment[]).map((dep) => (
                  <option key={dep} value={dep}>{HR_DEPARTMENT_LABEL[dep]}</option>
                ))}
              </select>
            </label>
            {!existing && (
              <label className="grid gap-1 text-sm font-semibold text-navy-800">
                حالة العمل
                <select value={workStatus} onChange={(event) => setWorkStatus(event.target.value as HrWorkStatus)}
                  className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
                  {(Object.keys(HR_WORK_STATUS_LABEL) as HrWorkStatus[]).map((status) => (
                    <option key={status} value={status}>{HR_WORK_STATUS_LABEL[status]}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              تاريخ الالتحاق
              <input type="date" value={hireDate} onChange={(event) => setHireDate(event.target.value)}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              تاريخ الانتهاء
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
            </label>
          </div>

          <fieldset className="rounded-xl border border-navy-100 p-3">
            <legend className="px-1 text-sm font-bold text-navy-900">نوع التعاقد وشروط الأجر</legend>
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-3 text-sm">
                {(Object.keys(HR_CONTRACT_KIND_LABEL) as HrContractKind[]).map((kind) => (
                  <label key={kind} className="flex items-center gap-1.5 font-semibold text-navy-800">
                    <input type="radio" name="contractKind" checked={contractKind === kind}
                      onChange={() => { setContractKind(kind); if (kind === "commission") setHasPay(false); }} />
                    {HR_CONTRACT_KIND_LABEL[kind]}
                  </label>
                ))}
              </div>
              <p className="rounded-lg bg-info-50 p-2 text-xs text-info-900">
                تعاقد «النسبة» يُقرأ من ملف الطبيب في الجهات الحالي ولا يُعدَّل من هنا — إضافة ملفٍ لا تغيّر نسبته.
                أما الراتب فيُحفظ بعملته ودوريته وتاريخ سريانه.
              </p>
              {contractKind !== "commission" && (
                <label className="flex items-center gap-2 text-sm font-semibold text-navy-800">
                  <input type="checkbox" checked={hasPay} onChange={(event) => setHasPay(event.target.checked)} />
                  يوجد راتبٌ محدد الآن
                </label>
              )}
              {contractKind !== "commission" && hasPay && (
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="grid gap-1 text-sm font-semibold text-navy-800 sm:col-span-1">
                    المبلغ (وحدات صغرى)
                    <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)}
                      className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-navy-800">
                    العملة
                    <input value={currency} onChange={(event) => setCurrency(event.target.value)} maxLength={3}
                      className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums uppercase" />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-navy-800">
                    الدورية
                    <select value={period} onChange={(event) => setPeriod(event.target.value as HrSalaryPeriod)}
                      className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
                      {(Object.keys(HR_SALARY_PERIOD_LABEL) as HrSalaryPeriod[]).map((value) => (
                        <option key={value} value={value}>{HR_SALARY_PERIOD_LABEL[value]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-navy-800">
                    سريان المبلغ
                    <input type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)}
                      className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
                  </label>
                </div>
              )}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              الهاتف
              <input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
            </label>
            {existing && (
              <label className="grid gap-1 text-sm font-semibold text-navy-800">
                سبب هذا التعديل (يُسجَّل)
                <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300}
                  className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
              </label>
            )}
          </div>
          <label className="grid gap-1 text-sm font-semibold text-navy-800">
            ملاحظة
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000}
              className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
          </label>

          {existing && (
            <section aria-label="حساب الدخول" className="rounded-xl border border-navy-100 p-3 text-sm">
              <h3 className="mb-2 font-bold text-navy-900">حساب الدخول — اختياري وفريد</h3>
              {detail?.linkedUser ? (
                <div className="grid gap-2">
                  <p className="text-navy-700">
                    مرتبط بالحساب «{detail.linkedUser.username}» ({detail.linkedUser.displayName}) — دور الدخول: {detail.linkedUser.role}.
                    {detail.linkedUser.isActive ? "" : " الحساب معطّل حاليًا."}
                  </p>
                  <p className="text-xs text-navy-500">
                    الملف ليس حسابًا: صلاحيات الدخول تُدار من شاشة المستخدمين وحدها، ولا يُنشأ حسابٌ من هنا.
                  </p>
                  {!linkMode && (
                    <button onClick={() => setLinkMode(true)} className="justify-self-start rounded-xl bg-navy-100 px-4 py-1.5 text-xs font-semibold text-navy-800">
                      فكّ الربط…
                    </button>
                  )}
                  {linkMode && (
                    <div className="grid gap-2">
                      <input value={linkReason} onChange={(event) => setLinkReason(event.target.value)} maxLength={300}
                        placeholder="سبب الفكّ (إلزامي — يُسجَّل)"
                        className="rounded-xl border border-navy-200 px-3 py-2 text-sm" />
                      <div className="flex gap-2">
                        <button disabled={busy || !linkReason.trim()} onClick={() => void submitLink("unlink_user")}
                          className="rounded-xl bg-danger-700 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">تأكيد الفكّ</button>
                        <button onClick={() => setLinkMode(false)} className="rounded-xl bg-white px-4 py-1.5 text-xs font-semibold text-navy-800">تراجع</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-2">
                  <p className="text-navy-700">بلا حساب دخول — يصلح لمن لا يدخل البرنامج (حارس، منسق…).</p>
                  {!linkMode && (
                    <button onClick={() => setLinkMode(true)} className="justify-self-start rounded-xl bg-navy-100 px-4 py-1.5 text-xs font-semibold text-navy-800">
                      ربط بحسابٍ موجود…
                    </button>
                  )}
                  {linkMode && (
                    <div className="grid gap-2">
                      <select value={linkUserId} onChange={(event) => setLinkUserId(event.target.value)}
                        className="rounded-xl border border-navy-200 px-3 py-2 text-sm">
                        <option value="">اختر الحساب الموجود…</option>
                        {userOptions.map((user) => (
                          <option key={user.id} value={user.id}>{user.username} — {user.displayName} ({user.role})</option>
                        ))}
                      </select>
                      <input value={linkReason} onChange={(event) => setLinkReason(event.target.value)} maxLength={300}
                        placeholder="سبب الربط (إلزامي — يُسجَّل)"
                        className="rounded-xl border border-navy-200 px-3 py-2 text-sm" />
                      <div className="flex gap-2">
                        <button disabled={busy || !linkUserId || !linkReason.trim()} onClick={() => void submitLink("link_user")}
                          className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">ربط</button>
                        <button onClick={() => setLinkMode(false)} className="rounded-xl bg-white px-4 py-1.5 text-xs font-semibold text-navy-800">تراجع</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {existing && detail && detail.changes.length > 0 && (
            <section aria-label="سجل تغييرات الملف" className="grid gap-1">
              <h3 className="text-sm font-bold text-navy-900">سجل التغييرات</h3>
              <ul className="grid max-h-40 gap-1 overflow-y-auto text-xs">
                {detail.changes.map((change) => (
                  <li key={change.id} className="rounded-lg bg-navy-50 px-3 py-1.5 text-navy-800">
                    <span className="font-semibold">{change.actor}</span>
                    {" "}— {CONTRACT_ACTION_LABEL[change.action] ?? change.action}
                    {change.field ? ` (${change.field})` : ""}
                    {change.oldValue !== null ? `: ${change.oldValue} ← ` : ": "}
                    {change.newValue}
                    {change.reason ? ` — السبب: ${change.reason}` : ""}
                    <span className="ms-2 text-navy-500">{fmtDate(change.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-xl bg-navy-100 px-4 py-2 text-sm font-semibold text-navy-800">إلغاء</button>
            <button onClick={() => void submit()} disabled={busy || fullName.trim().length < 2}
              className="rounded-xl bg-accent-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "جارٍ الحفظ…" : "حفظ"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
