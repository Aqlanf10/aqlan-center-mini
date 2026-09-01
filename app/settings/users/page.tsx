"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLES, ROLE_HINT, ROLE_LABEL, type Role } from "@/lib/roles";
import { friendlyDateLong } from "@/lib/reminders";
import {
  type DoctorPermissions,
  type DoctorCommissionConfig,
  type CommissionCalculationMode,
  type CustomDoctorServiceRate,
  DENTAL_SERVICE_CATEGORIES,
  PRESET_SPECIALTIES,
  PRESET_BRANCHES,
  DEFAULT_DOCTOR_PERMISSIONS,
  DEFAULT_DOCTOR_COMMISSION_CONFIG,
  parseDoctorPermissions,
  parseDoctorCommissionConfig,
  isDoctorFinancialHidden,
} from "@/lib/doctor-permissions";

interface ClinicServiceItem {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
}

interface StaffAccount {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  specialty?: string | null;
  branch?: string | null;
  /** جهة «طبيب» المرتبطة (V2 §٣٥) — ربط الحساب بجهته للعزل الخادم. */
  partyId?: number | null;
  partyName?: string | null;
  permissions?: DoctorPermissions | null;
  commissionConfig?: DoctorCommissionConfig | null;
  createdAt: string;
}

/** جهات الأطباء من الدليل — لربط حساب الطبيب بجهته (V2 §٣٥/٣٧). */
interface DoctorParty {
  id: number;
  name: string;
}

export default function UsersAndDoctorsPage() {
  const [users, setUsers] = useState<StaffAccount[]>([]);
  const [clinicServices, setClinicServices] = useState<ClinicServiceItem[]>([]);
  const [doctorParties, setDoctorParties] = useState<DoctorParty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tabFilter, setTabFilter] = useState<"all" | "doctor" | "reception" | "admin">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Dialogs
  const [adding, setAdding] = useState(false);
  const [editingUser, setEditingUser] = useState<StaffAccount | null>(null);
  const [activeEditorTab, setActiveEditorTab] = useState<"basic" | "permissions" | "commission">("basic");

  // State for adding a new special service rate
  const [newSpecialRate, setNewSpecialRate] = useState<{
    serviceMode: "from_list" | "custom_text";
    serviceId: number | null;
    serviceName: string;
    category: string;
    percent: number;
    note: string;
  }>({
    serviceMode: "from_list",
    serviceId: null,
    serviceName: "",
    category: "ortho",
    percent: 35,
    note: "",
  });

  // Create Form State
  const [createForm, setCreateForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "doctor" as Role,
    specialty: PRESET_SPECIALTIES[0],
    branch: PRESET_BRANCHES[0],
    defaultPercent: 30,
    financialScope: "own_commissions_only" as "own_commissions_only" | "clinic_and_own",
  });

  // Edit Form State
  const [editForm, setEditForm] = useState<{
    displayName: string;
    role: Role;
    isActive: boolean;
    specialty: string;
    branch: string;
    newPassword: string;
    permissions: DoctorPermissions;
    commissionConfig: DoctorCommissionConfig;
  }>({
    displayName: "",
    role: "doctor",
    isActive: true,
    specialty: "",
    branch: "",
    newPassword: "",
    permissions: { ...DEFAULT_DOCTOR_PERMISSIONS },
    commissionConfig: { ...DEFAULT_DOCTOR_COMMISSION_CONFIG },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, servicesRes, partiesRes] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }),
        fetch("/api/services?all=1", { cache: "no-store" }).catch(() => null),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }).catch(() => null),
      ]);
      const payload = await usersRes.json();
      if (!usersRes.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setUsers(payload as StaffAccount[]);

      if (servicesRes && servicesRes.ok) {
        const servs = await servicesRes.json().catch(() => []);
        if (Array.isArray(servs)) {
          setClinicServices(servs as ClinicServiceItem[]);
        }
      }

      /* جهات الأطباء (V2 §٣٥): ربط الحساب بجهته هو أساس عزل الخادم — بلا ربطٍ
         يبقى الطبيب على السلوك القديم حتى يربطه المدير. */
      if (partiesRes && partiesRes.ok) {
        const parties = await partiesRes.json().catch(() => []);
        if (Array.isArray(parties)) {
          setDoctorParties(parties as DoctorParty[]);
        }
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleAddSpecialRate = (override?: {
    name: string;
    percent: number;
    category?: string;
    serviceId?: number;
  }) => {
    const targetName = (override?.name ?? newSpecialRate.serviceName).trim();
    const targetPercent = override?.percent !== undefined ? override.percent : newSpecialRate.percent;
    const targetCategory = override?.category ?? newSpecialRate.category;
    const targetServiceId = override?.serviceId !== undefined ? override.serviceId : newSpecialRate.serviceId;
    const targetNote = override ? "" : newSpecialRate.note.trim();

    if (!targetName) return;

    const validPercent = Math.max(0, Math.min(100, targetPercent));
    const newEntry: CustomDoctorServiceRate = {
      id: `csr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      serviceName: targetName,
      percent: validPercent,
      serviceId: targetServiceId ?? undefined,
      category: targetCategory,
      note: targetNote || undefined,
    };

    setEditForm((c) => {
      const existing = c.commissionConfig.customServiceRates ?? [];
      const filtered = existing.filter(
        (r) =>
          r.serviceName.trim().toLowerCase() !== targetName.toLowerCase() &&
          (!targetServiceId || r.serviceId !== targetServiceId),
      );
      const updatedRates = [...filtered, newEntry];
      const newServiceRatesMap: Record<string, number> = {
        ...(c.commissionConfig.serviceRates ?? {}),
        [targetName.toLowerCase()]: validPercent,
      };
      if (targetServiceId) {
        newServiceRatesMap[String(targetServiceId)] = validPercent;
      }

      return {
        ...c,
        commissionConfig: {
          ...c.commissionConfig,
          customServiceRates: updatedRates,
          serviceRates: newServiceRatesMap,
        },
      };
    });

    // Reset input fields
    setNewSpecialRate({
      serviceMode: "from_list",
      serviceId: null,
      serviceName: "",
      category: "ortho",
      percent: 35,
      note: "",
    });
  };

  const handleRemoveSpecialRate = (rateId: string, serviceName: string, serviceId?: number) => {
    setEditForm((c) => {
      const existing = c.commissionConfig.customServiceRates ?? [];
      const updated = existing.filter((r) => r.id !== rateId);
      const newServiceRatesMap = { ...(c.commissionConfig.serviceRates ?? {}) };
      delete newServiceRatesMap[serviceName.toLowerCase()];
      if (serviceId) delete newServiceRatesMap[String(serviceId)];

      return {
        ...c,
        commissionConfig: {
          ...c.commissionConfig,
          customServiceRates: updated,
          serviceRates: newServiceRatesMap,
        },
      };
    });
  };

  const handleUpdateSpecialRatePercent = (rateId: string, newPercent: number) => {
    const valid = Math.max(0, Math.min(100, newPercent));
    setEditForm((c) => {
      const existing = c.commissionConfig.customServiceRates ?? [];
      const updated = existing.map((r) => (r.id === rateId ? { ...r, percent: valid } : r));
      const target = existing.find((r) => r.id === rateId);
      const newServiceRatesMap = { ...(c.commissionConfig.serviceRates ?? {}) };
      if (target) {
        newServiceRatesMap[target.serviceName.toLowerCase()] = valid;
        if (target.serviceId) newServiceRatesMap[String(target.serviceId)] = valid;
      }

      return {
        ...c,
        commissionConfig: {
          ...c.commissionConfig,
          customServiceRates: updated,
          serviceRates: newServiceRatesMap,
        },
      };
    });
  };

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (run: () => Promise<Response>) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        const response = await run();
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر التنفيذ.");
          return false;
        }
        await load();
        return true;
      } catch {
        setError("تعذّر الاتصال بالخادم.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const openEditor = (user: StaffAccount, initialTab: "basic" | "permissions" | "commission" = "basic") => {
    setEditingUser(user);
    setActiveEditorTab(user.role === "doctor" ? initialTab : "basic");
    setEditForm({
      displayName: user.displayName,
      role: user.role,
      isActive: user.isActive,
      specialty: user.specialty ?? (user.role === "doctor" ? PRESET_SPECIALTIES[0] : ""),
      branch: user.branch ?? PRESET_BRANCHES[0],
      newPassword: "",
      permissions: parseDoctorPermissions(user.permissions, user.role),
      commissionConfig: parseDoctorCommissionConfig(user.commissionConfig),
    });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const config = {
      ...DEFAULT_DOCTOR_COMMISSION_CONFIG,
      defaultPercent: createForm.defaultPercent,
    };
    const permissions = createForm.role === "doctor"
      ? (createForm.financialScope === "clinic_and_own"
          ? {
              ...DEFAULT_DOCTOR_PERMISSIONS,
              financialScope: "clinic_and_own" as const,
              canViewClinicRevenue: true,
              canViewClinicFinance: true,
              canViewCostPrices: true,
              canViewExpenses: true,
              canViewClinicProfits: true,
            }
          : { ...DEFAULT_DOCTOR_PERMISSIONS })
      : undefined;

    const ok = await send(() =>
      fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: createForm.username,
          displayName: createForm.displayName,
          password: createForm.password,
          role: createForm.role,
          specialty: createForm.role === "doctor" ? createForm.specialty : undefined,
          branch: createForm.branch,
          permissions,
          commissionConfig: createForm.role === "doctor" ? config : undefined,
        }),
      }),
    );

    if (ok) {
      setSuccess("تم إنشاء الحساب بنجاح.");
      setAdding(false);
      setCreateForm({
        username: "",
        displayName: "",
        password: "",
        role: "doctor",
        specialty: PRESET_SPECIALTIES[0],
        branch: PRESET_BRANCHES[0],
        defaultPercent: 30,
        financialScope: "own_commissions_only",
      });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingUser) return;
    const patchBody: Record<string, unknown> = {
      displayName: editForm.displayName,
      role: editForm.role,
      isActive: editForm.isActive,
      specialty: editForm.specialty,
      branch: editForm.branch,
    };

    if (editForm.newPassword.trim()) {
      patchBody.password = editForm.newPassword.trim();
    }

    if (editForm.role === "doctor") {
      patchBody.permissions = editForm.permissions;
      patchBody.commissionConfig = editForm.commissionConfig;
    }

    const ok = await send(() =>
      fetch(`/api/users/${editingUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      }),
    );

    if (ok) {
      setSuccess(`تم تحديث بيانات وصلاحيات ${editForm.displayName} بنجاح.`);
      setEditingUser(null);
    }
  };

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (tabFilter !== "all" && u.role !== tabFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesName = u.displayName.toLowerCase().includes(q);
        const matchesUser = u.username.toLowerCase().includes(q);
        const matchesSpec = (u.specialty ?? "").toLowerCase().includes(q);
        if (!matchesName && !matchesUser && !matchesSpec) return false;
      }
      return true;
    });
  }, [users, tabFilter, searchQuery]);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24 text-slate-800" dir="rtl">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black text-navy-900">المستخدمون والأطباء</h1>
            <span className="rounded-full bg-brand-blue/10 px-2.5 py-0.5 text-xs font-bold text-brand-blue">
              {users.length} مستخدم
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            إدارة حسابات الأطباء والموظفين، الصلاحيات الدقيقة، ونِسب وتصنيفات احتساب المستحقات
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/settings"
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-navy-800 transition-colors hover:bg-slate-50"
          >
            ‹ رجوع للإعدادات
          </a>
          <button
            onClick={() => {
              setAdding(true);
              setEditingUser(null);
            }}
            className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-sm transition-opacity hover:opacity-90"
          >
            + إضافة طبيب / مستخدم جديد
          </button>
        </div>
      </header>

      {/* Alerts */}
      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-bold text-red-700">
          ⚠️ {error}
        </div>
      )}
      {success && (
        <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-bold text-emerald-800">
          ✓ {success}
        </div>
      )}

      {/* Filter Tabs & Search */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl bg-slate-100 p-1">
          {(
            [
              { id: "all", label: "الجميع" },
              { id: "doctor", label: "الأطباء" },
              { id: "reception", label: "الاستقبال" },
              { id: "admin", label: "الإدارة" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTabFilter(tab.id)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                tabFilter === tab.id
                  ? "bg-white text-navy-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="w-full sm:w-64">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث بالاسم أو التخصص..."
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-brand-blue"
          />
        </div>
      </div>

      {/* User Creation Form */}
      {adding && (
        <form
          onSubmit={handleCreate}
          className="mb-6 rounded-2xl border-2 border-brand-blue/40 bg-white p-5 shadow-sm"
        >
          <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-sm font-black text-navy-900">إنشاء حساب مستخدم جديد</h2>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs font-bold text-slate-400 hover:text-slate-600"
            >
              إلغاء ✕
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">الاسم الظاهر الكامل *</label>
              <input
                value={createForm.displayName}
                onChange={(e) => setCreateForm((c) => ({ ...c, displayName: e.target.value }))}
                placeholder="د. أحمد علي"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">اسم الدخول (إنجليزية فقط) *</label>
              <input
                value={createForm.username}
                onChange={(e) => setCreateForm((c) => ({ ...c, username: e.target.value }))}
                placeholder="dr.ahmed"
                dir="ltr"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">كلمة المرور (8 أحرف فأكثر) *</label>
              <input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((c) => ({ ...c, password: e.target.value }))}
                placeholder="••••••••"
                dir="ltr"
                required
                minLength={8}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">الدور والوظيفة</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((c) => ({ ...c, role: e.target.value as Role }))}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            </div>

            {createForm.role === "doctor" && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-bold text-slate-700">التخصص الطبي</label>
                  <input
                    list="specialties-list"
                    value={createForm.specialty}
                    onChange={(e) => setCreateForm((c) => ({ ...c, specialty: e.target.value }))}
                    placeholder="اختر أو اكتب التخصص..."
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  />
                  <datalist id="specialties-list">
                    {PRESET_SPECIALTIES.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-bold text-slate-700">النسبة الافتراضية للطبيب (%)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={createForm.defaultPercent}
                      onChange={(e) =>
                        setCreateForm((c) => ({ ...c, defaultPercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))
                      }
                      className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold"
                    />
                    <span className="text-xs text-slate-500">% من التحصيل الفعلي</span>
                  </div>
                </div>

                {/* Scope selector for new doctor */}
                <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-3 sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">🛡️</span>
                      <span className="text-xs font-black text-amber-950">نظام الرؤية المالية (المالية المخفية)</span>
                    </div>
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-900">
                      {createForm.financialScope === "own_commissions_only" ? "🔒 وضع المالية المخفية (موصى به)" : "👁️ كشف مالية المركز"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-amber-800">
                    يحدد ما إذا كان الطبيب يرى إيرادات المركز أو مستحقاته الشخصية فقط، مع إخفاء أسعار التكلفة للمواد وفواتير المعامل والمصروفات والأرباح افتراضياً.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setCreateForm((c) => ({ ...c, financialScope: "own_commissions_only" }))}
                      className={`flex-1 rounded-xl border p-2.5 text-right transition-all ${
                        createForm.financialScope === "own_commissions_only"
                          ? "border-amber-600 bg-white text-amber-950 shadow-xs ring-2 ring-amber-500/20"
                          : "border-amber-200 bg-amber-50/50 text-slate-600 hover:bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black">🔒 مستحقاته الشخصية فقط (الافتراضي)</span>
                        {createForm.financialScope === "own_commissions_only" && (
                          <span className="text-[10px] font-bold text-amber-700">✓ مفعّل</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        إخفاء إيرادات المركز وأسعار التكلفة والمصروفات والأرباح العامة تماماً عن الطبيب
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateForm((c) => ({ ...c, financialScope: "clinic_and_own" }))}
                      className={`flex-1 rounded-xl border p-2.5 text-right transition-all ${
                        createForm.financialScope === "clinic_and_own"
                          ? "border-blue-600 bg-white text-blue-950 shadow-xs ring-2 ring-blue-500/20"
                          : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black">👁️ كشف إيرادات ومالية المركز</span>
                        {createForm.financialScope === "clinic_and_own" && (
                          <span className="text-[10px] font-bold text-blue-700">✓ مفعّل</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        كشف إيرادات المركز والتقارير التنفيذية (للأطباء الشركاء أو المشرفين الإداريين)
                      </p>
                    </button>
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">الفرع التابع له</label>
              <select
                value={createForm.branch}
                onChange={(e) => setCreateForm((c) => ({ ...c, branch: e.target.value }))}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
              >
                {PRESET_BRANCHES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !createForm.username.trim() || createForm.password.length < 8}
              className="rounded-xl bg-brand-orange px-5 py-2 text-xs font-extrabold text-white disabled:opacity-50"
            >
              {busy ? "جارٍ الحفظ..." : "حفظ وإنشاء الحساب"}
            </button>
          </div>
        </form>
      )}

      {/* Users List */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-400">
          جارٍ تحميل الحسابات والصلاحيات…
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm text-slate-400">
          لا يوجد مستخدمون يطابقون البحث.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredUsers.map((user) => {
            const isDoctor = user.role === "doctor";
            const comm = parseDoctorCommissionConfig(user.commissionConfig);
            const perms = parseDoctorPermissions(user.permissions, user.role);

            return (
              <div
                key={user.id}
                className={`rounded-2xl border p-4 transition-all ${
                  user.isActive
                    ? "border-slate-200 bg-white shadow-xs hover:border-slate-300"
                    : "border-slate-200 bg-slate-50/70 opacity-70"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* Basic Column */}
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-bold ${
                        isDoctor
                          ? "bg-emerald-100 text-emerald-800"
                          : user.role === "admin"
                          ? "bg-purple-100 text-purple-800"
                          : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      {isDoctor ? "👨‍⚕️" : user.role === "admin" ? "🛡️" : "📋"}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-extrabold text-navy-900">{user.displayName}</h3>
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold ${
                            user.isActive
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-red-50 text-red-700"
                          }`}
                        >
                          {user.isActive ? "حساب نشط" : "موقوف"}
                        </span>
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                          {ROLE_LABEL[user.role]}
                        </span>
                      </div>

                      <p className="mt-0.5 text-xs text-slate-500">
                        <span dir="ltr" className="font-mono text-[11px] text-slate-600">
                          @{user.username}
                        </span>
                        {user.specialty && (
                          <span className="mr-2 font-medium text-emerald-800">
                            • {user.specialty}
                          </span>
                        )}
                        {user.branch && (
                          <span className="mr-2 text-slate-400">• فرع: {user.branch}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Doctor Commission & Permissions Badges */}
                  {isDoctor && (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-1.5 text-right">
                        <div className="text-[10px] font-bold text-emerald-800">طريقة الاحتساب</div>
                        <div className="text-xs font-black text-emerald-900">
                          {comm.calculationMode === "by_category"
                            ? "نسب متغيرة حسب الخدمة"
                            : comm.calculationMode === "fixed"
                            ? "مبلغ ثابت"
                            : `${comm.defaultPercent}% عامة`}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-1.5 text-right">
                        <div className="text-[10px] font-bold text-slate-500">نطاق رؤية المرضى</div>
                        <div className="text-xs font-black text-slate-700">
                          {perms.canViewAllPatients ? "👁️ جميع المرضى" : "🔒 مرضاه فقط"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-1.5 text-right">
                        <div className="text-[10px] font-bold text-amber-800">الرؤية المالية</div>
                        <div className="text-xs font-black">
                          {isDoctorFinancialHidden(perms, user.role) ? (
                            <span className="text-amber-900">🔒 مالية مخفية (مستحقاته فقط)</span>
                          ) : (
                            <span className="text-blue-900">👁️ إيرادات المركز</span>
                          )}
                        </div>
                      </div>

                      {comm.customServiceRates && comm.customServiceRates.length > 0 && (
                        <div className="rounded-xl border border-teal-200 bg-teal-50/80 px-3 py-1.5 text-right">
                          <div className="text-[10px] font-bold text-teal-800">نسب خدمات خاصة</div>
                          <div className="text-xs font-black text-teal-950">
                            🎯 {comm.customServiceRates.length} خدمة محددة
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isDoctor ? (
                      <>
                        <button
                          onClick={() => openEditor(user, "permissions")}
                          className="rounded-xl border border-brand-blue/30 bg-brand-blue/5 px-3 py-1.5 text-xs font-bold text-brand-blue transition-colors hover:bg-brand-blue/10"
                        >
                          🔐 الصلاحيات
                        </button>
                        <button
                          onClick={() => openEditor(user, "commission")}
                          className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 transition-colors hover:bg-emerald-100"
                        >
                          💰 النِسب والأتعاب
                        </button>
                      </>
                    ) : null}

                    <button
                      onClick={() => openEditor(user, "basic")}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      تعديل الملف
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Doctor / User Dedicated Modal Drawer */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <div>
                <h2 className="text-base font-black text-navy-900">
                  ملف {editingUser.role === "doctor" ? "الطبيب" : "المستخدم"}: {editingUser.displayName}
                </h2>
                <p className="text-xs text-slate-500">
                  اسم الدخول: <span dir="ltr" className="font-mono">@{editingUser.username}</span> • الدور: {ROLE_LABEL[editingUser.role]}
                </p>
              </div>
              <button
                onClick={() => setEditingUser(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-slate-200 bg-slate-50 px-4">
              <button
                onClick={() => setActiveEditorTab("basic")}
                className={`border-b-2 px-4 py-2.5 text-xs font-bold transition-all ${
                  activeEditorTab === "basic"
                    ? "border-brand-blue text-brand-blue"
                    : "border-transparent text-slate-500 hover:text-slate-900"
                }`}
              >
                👤 البيانات الأساسية
              </button>
              {editingUser.role === "doctor" && (
                <>
                  <button
                    onClick={() => setActiveEditorTab("permissions")}
                    className={`border-b-2 px-4 py-2.5 text-xs font-bold transition-all ${
                      activeEditorTab === "permissions"
                        ? "border-brand-blue text-brand-blue"
                        : "border-transparent text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    🔒 الصلاحيات والخصوصية
                  </button>
                  <button
                    onClick={() => setActiveEditorTab("commission")}
                    className={`border-b-2 px-4 py-2.5 text-xs font-bold transition-all ${
                      activeEditorTab === "commission"
                        ? "border-brand-blue text-brand-blue"
                        : "border-transparent text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    💰 النِسب وطريقة احتساب الأتعاب
                  </button>
                </>
              )}
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 text-xs">
              {/* Tab 1: Basic Info */}
              {activeEditorTab === "basic" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block font-bold text-slate-700">الاسم الظاهر</label>
                      <input
                        type="text"
                        value={editForm.displayName}
                        onChange={(e) => setEditForm((c) => ({ ...c, displayName: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block font-bold text-slate-700">الدور الوظيفي</label>
                      <select
                        value={editForm.role}
                        onChange={(e) => setEditForm((c) => ({ ...c, role: e.target.value as Role }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </option>
                        ))}
                      </select>
                    </div>

                    {editForm.role === "doctor" && (
                      <div>
                        <label className="mb-1 block font-bold text-slate-700">التخصص الطبي</label>
                        <input
                          list="edit-specialties-list"
                          value={editForm.specialty}
                          onChange={(e) => setEditForm((c) => ({ ...c, specialty: e.target.value }))}
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                        />
                        <datalist id="edit-specialties-list">
                          {PRESET_SPECIALTIES.map((s) => (
                            <option key={s} value={s} />
                          ))}
                        </datalist>
                      </div>
                    )}

                    <div>
                      <label className="mb-1 block font-bold text-slate-700">الفرع التابع له</label>
                      <select
                        value={editForm.branch}
                        onChange={(e) => setEditForm((c) => ({ ...c, branch: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                      >
                        {PRESET_BRANCHES.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block font-bold text-slate-700">حالة الحساب</label>
                      <select
                        value={editForm.isActive ? "active" : "inactive"}
                        onChange={(e) =>
                          setEditForm((c) => ({ ...c, isActive: e.target.value === "active" }))
                        }
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                      >
                        <option value="active">نشط ومفعل</option>
                        <option value="inactive">موقوف مؤقتاً</option>
                      </select>
                    </div>

                    {/* ربط حساب الطبيب بجهته (V2 §٣٥/٣٧/٣٩) — أساس عزل الخادم.
                        من دون ربطٍ يرى الطبيب كل المرضى (السلوك القديم) حتى يربطه
                        المدير؛ وربطه يخصّص رؤيته لمرضاه في كل استعلام. */}
                    {editForm.role === "doctor" && (
                      <div className="sm:col-span-2">
                        <label className="mb-1 block font-bold text-slate-700">
                          جهة «طبيب» المرتبطة — أساس عزل مرضى الحساب في الخادم
                        </label>
                        <select
                          value={editingUser.partyId ?? ""}
                          onChange={(e) =>
                            send(() =>
                              fetch(`/api/users/${editingUser.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  action: "link_doctor",
                                  partyId: e.target.value ? Number(e.target.value) : null,
                                }),
                              }),
                            )
                          }
                          disabled={busy}
                          aria-label="ربط الطبيب"
                          className="w-full rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs font-bold text-sky-900"
                        >
                          <option value="">— بلا ربط (يرى كل المرضى) —</option>
                          {doctorParties.map((doctor) => (
                            <option key={doctor.id} value={doctor.id}>
                              {doctor.name}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {editingUser.partyName
                            ? `مربوط حاليًا بـ${editingUser.partyName} — يرى مرضاه وحالاته فقط`
                            : "غير مربوط — يرى كل المرضى حتى يُربط"}
                        </p>
                      </div>
                    )}

                    <div>
                      <label className="mb-1 block font-bold text-slate-700">
                        تغيير كلمة المرور (اتركها فارغة إن لم ترغب بتغييرها)
                      </label>
                      <input
                        type="password"
                        value={editForm.newPassword}
                        onChange={(e) => setEditForm((c) => ({ ...c, newPassword: e.target.value }))}
                        placeholder="كلمة مرور جديدة (8 أحرف فأكثر)"
                        dir="ltr"
                        autoComplete="new-password"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Permissions Matrix */}
              {activeEditorTab === "permissions" && (
                <div className="space-y-4">
                  {/* Security Notice */}
                  <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5 text-blue-900 shadow-xs">
                    <div className="flex items-start gap-2.5">
                      <span className="text-lg">🛡️</span>
                      <div>
                        <p className="text-xs font-black text-blue-950">قاعدة الأمان الافتراضية والتحكم بالصلاحيات:</p>
                        <p className="mt-1 text-[11px] leading-relaxed text-blue-800">
                          يرى الطبيب تلقائيًا مرضاه وحالاته ومواعيده الخاصة فقط. لا يستطيع فتح ملف مريض آخر أو الاطلاع على المالية العامة أو عمولات زملائه إلا إذا فُعّلت له صراحة هنا من قبل الإدارة. يتم تطبيق كافة القيود على مستوى الخادم (Server-Side) لمنع الوصول غير المصرح به.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Preset Fast Configurations */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                    <div className="mb-2 text-xs font-black text-slate-800">⚡ قوالب جاهزة لضبط الصلاحيات بنقرة واحدة:</div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <button
                        type="button"
                        onClick={() => {
                          setEditForm((c) => ({
                            ...c,
                            permissions: {
                              ...DEFAULT_DOCTOR_PERMISSIONS,
                            },
                          }));
                        }}
                        className="rounded-lg border border-slate-200 bg-white p-2 text-right transition-all hover:border-brand-blue hover:bg-blue-50/30"
                      >
                        <div className="text-[11px] font-black text-slate-800">🛡️ الوضع القياسي الآمن</div>
                        <div className="mt-0.5 text-[9px] text-slate-500">مرضاه فقط + مالية مخفية</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setEditForm((c) => ({
                            ...c,
                            permissions: {
                              ...c.permissions,
                              canViewAllPatients: true,
                              canAddPatient: true,
                              canEditPatient: true,
                              canDeletePatient: false,
                              canViewPlans: true,
                              canEditPlans: true,
                              canViewXrays: true,
                              canUploadXrays: true,
                              canViewAllAppointments: true,
                              financialScope: "own_commissions_only",
                              canViewCostPrices: false,
                              canViewExpenses: false,
                              canViewClinicProfits: false,
                              canViewOtherDoctorsAccounts: false,
                              canViewClinicRevenue: false,
                              canViewClinicFinance: false,
                              canViewOwnCommissions: true,
                              canViewCashDrawer: false,
                              canViewServicePrices: true,
                              canViewPatientPayments: true,
                            },
                          }));
                        }}
                        className="rounded-lg border border-slate-200 bg-white p-2 text-right transition-all hover:border-brand-blue hover:bg-blue-50/30"
                      >
                        <div className="text-[11px] font-black text-slate-800">👑 استشاري / مشرف</div>
                        <div className="mt-0.5 text-[9px] text-slate-500">كل المرضى + جدول كامل</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setEditForm((c) => ({
                            ...c,
                            permissions: {
                              ...c.permissions,
                              canViewAllPatients: true,
                              canAddPatient: true,
                              canEditPatient: true,
                              canDeletePatient: false,
                              canViewPlans: true,
                              canEditPlans: true,
                              canViewXrays: true,
                              canUploadXrays: true,
                              canViewAllAppointments: true,
                              financialScope: "clinic_and_own",
                              canViewCostPrices: true,
                              canViewExpenses: true,
                              canViewClinicProfits: true,
                              canViewOtherDoctorsAccounts: true,
                              canViewClinicRevenue: true,
                              canViewClinicFinance: true,
                              canViewOwnCommissions: true,
                              canViewCashDrawer: true,
                              canViewServicePrices: true,
                              canViewPatientPayments: true,
                            },
                          }));
                        }}
                        className="rounded-lg border border-slate-200 bg-white p-2 text-right transition-all hover:border-brand-blue hover:bg-blue-50/30"
                      >
                        <div className="text-[11px] font-black text-slate-800">💼 طبيب شريك</div>
                        <div className="mt-0.5 text-[9px] text-slate-500">صلاحيات ومالية شاملة</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setEditForm((c) => ({
                            ...c,
                            permissions: {
                              ...c.permissions,
                              canViewAllPatients: false,
                              canAddPatient: false,
                              canEditPatient: false,
                              canDeletePatient: false,
                              canViewPlans: true,
                              canEditPlans: false,
                              canViewXrays: true,
                              canUploadXrays: false,
                              canViewAllAppointments: false,
                              financialScope: "own_commissions_only",
                              canViewCostPrices: false,
                              canViewExpenses: false,
                              canViewClinicProfits: false,
                              canViewOtherDoctorsAccounts: false,
                              canViewClinicRevenue: false,
                              canViewClinicFinance: false,
                              canViewOwnCommissions: false,
                              canViewCashDrawer: false,
                              canViewServicePrices: false,
                              canViewPatientPayments: false,
                            },
                          }));
                        }}
                        className="rounded-lg border border-slate-200 bg-white p-2 text-right transition-all hover:border-slate-400 hover:bg-slate-100"
                      >
                        <div className="text-[11px] font-black text-slate-700">🔒 مقيد سريرياً</div>
                        <div className="mt-0.5 text-[9px] text-slate-500">معاينة فقط بدون تعديل</div>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {/* Section 1: Patients & Records */}
                    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                      <h4 className="mb-3 flex items-center gap-2 text-xs font-black text-navy-900">
                        <span>👥</span>
                        <span>ملفات وسجلات المرضى (Patient Records)</span>
                      </h4>
                      <div className="space-y-2.5">
                        {/* canViewAllPatients */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewAllPatients: !c.permissions.canViewAllPatients },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewAllPatients: !c.permissions.canViewAllPatients },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canViewAllPatients
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">
                                رؤية جميع مرضى المركز (للاستشاريين وحالات الطوارئ)
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewAllPatients
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {editForm.permissions.canViewAllPatients ? "✓ كافة المرضى" : "🔒 مرضاه فقط (محمي)"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              إيقافها يحجب الطبيب عن فتح أو استعراض أي ملف مريض لم يُعيّن له أو لم يقم بعلاجه شخصياً.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewAllPatients}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewAllPatients ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewAllPatients ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canAddPatient */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canAddPatient: !c.permissions.canAddPatient },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canAddPatient: !c.permissions.canAddPatient },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canAddPatient
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">إضافة وفتح ملف مريض جديد</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canAddPatient
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canAddPatient ? "✓ مسموح" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              تمكين الطبيب من إنشاء ملف جديد لمريض على النظام من داخل العيادة.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canAddPatient}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canAddPatient ? "bg-emerald-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canAddPatient ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canEditPatient */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canEditPatient: !c.permissions.canEditPatient },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canEditPatient: !c.permissions.canEditPatient },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canEditPatient
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">تعديل بيانات المرضى الأساسية</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canEditPatient
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canEditPatient ? "✓ مسموح" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              السماح للطبيب بتعديل الهاتف أو العنوان أو التاريخ المرضي لمرضاه.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canEditPatient}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canEditPatient ? "bg-emerald-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canEditPatient ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section 2: Clinical Plans & Radiographs */}
                    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                      <h4 className="mb-3 flex items-center gap-2 text-xs font-black text-navy-900">
                        <span>🦷</span>
                        <span>الخطط العلاجية والأشعة السنية (Treatment Plans & Imaging)</span>
                      </h4>
                      <div className="space-y-2.5">
                        {/* canViewPlans */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewPlans: !c.permissions.canViewPlans },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewPlans: !c.permissions.canViewPlans },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canViewPlans
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">عرض واستعراض خطط العلاج</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewPlans
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewPlans ? "✓ مفعّل" : "✕ محجوب"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              استعراض خطط المعالجة السابقة والجارية لمرضاه.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewPlans}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewPlans ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewPlans ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canEditPlans */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canEditPlans: !c.permissions.canEditPlans },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canEditPlans: !c.permissions.canEditPlans },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canEditPlans
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">إنشاء وتعديل بنود خطة العلاج</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canEditPlans
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canEditPlans ? "✓ مسموح" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              إضافة إجراءات وبنود سنية وجلسات علاجية وحفظ الخطة للمريض.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canEditPlans}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canEditPlans ? "bg-emerald-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canEditPlans ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewXrays */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewXrays: !c.permissions.canViewXrays },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewXrays: !c.permissions.canViewXrays },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canViewXrays
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">استعراض صور وأشعة المرضى</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewXrays
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewXrays ? "✓ مفعّل" : "✕ محجوب"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              فتح صور البانوراما والأشعة الذروية والمستندات الطبية.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewXrays}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewXrays ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewXrays ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canUploadXrays */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canUploadXrays: !c.permissions.canUploadXrays },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canUploadXrays: !c.permissions.canUploadXrays },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canUploadXrays
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">رفع وإدارة الأشعة والملفات السريرية</span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canUploadXrays
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canUploadXrays ? "✓ مسموح" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              إمكانية رفع ملفات أشعة جديدة وصور فموية لملف المريض.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canUploadXrays}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canUploadXrays ? "bg-emerald-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canUploadXrays ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section 3: Appointments & Scheduling */}
                    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                      <h4 className="mb-3 flex items-center gap-2 text-xs font-black text-navy-900">
                        <span>📅</span>
                        <span>المواعيد والجدول الزمني (Appointments & Schedule)</span>
                      </h4>
                      <div>
                        {/* canViewAllAppointments */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewAllAppointments: !c.permissions.canViewAllAppointments },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewAllAppointments: !c.permissions.canViewAllAppointments },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                            editForm.permissions.canViewAllAppointments
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900">
                                استعراض جدول المركز بالكامل (بدل مواعيده الخاصة فقط)
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewAllAppointments
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {editForm.permissions.canViewAllAppointments ? "✓ جدول المركز كاملاً" : "🔒 مواعيده فقط"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                              إيقافها يحصر شاشة المواعيد على مواعيد هذا الطبيب فقط ويخفي جدول الأطباء الآخرين.
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewAllAppointments}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewAllAppointments ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewAllAppointments ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section 4: Dedicated Hidden Finance & Privacy Policy */}
                    <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-4 shadow-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="flex items-center gap-1.5 text-xs font-black text-amber-950">
                            <span>🛡️</span>
                            <span>ميزة «المالية المخفية» للأطباء (Hidden Finance Policy)</span>
                          </h4>
                          <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
                            تتيح للإدارة حماية سرية حسابات المركز. بالوضع الافتراضي، يتم حجب إيرادات المركز وأسعار التكلفة للمواد والمعامل والمصروفات والأرباح العامة عن الطبيب، مع إتاحة مستحقاته الشخصية فقط.
                          </p>
                        </div>
                      </div>

                      {/* Policy Scope Selector Buttons */}
                      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditForm((c) => ({
                              ...c,
                              permissions: {
                                ...c.permissions,
                                financialScope: "own_commissions_only",
                                canViewClinicRevenue: false,
                                canViewClinicFinance: false,
                                canViewCostPrices: false,
                                canViewExpenses: false,
                                canViewClinicProfits: false,
                                canViewOtherDoctorsAccounts: false,
                                canViewOwnCommissions: true,
                              },
                            }));
                          }}
                          className={`rounded-xl border p-3 text-right transition-all ${
                            editForm.permissions.financialScope === "own_commissions_only" &&
                            !editForm.permissions.canViewClinicRevenue &&
                            !editForm.permissions.canViewClinicFinance
                              ? "border-amber-600 bg-white text-amber-950 shadow-sm ring-2 ring-amber-500/20"
                              : "border-amber-200 bg-amber-50/50 text-slate-600 hover:bg-white"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-black text-amber-900">
                              🔒 وضع المالية المخفية (الافتراضي والآمن)
                            </span>
                            {editForm.permissions.financialScope === "own_commissions_only" &&
                              !editForm.permissions.canViewClinicRevenue &&
                              !editForm.permissions.canViewClinicFinance && (
                                <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-800">
                                  ✓ نشط
                                </span>
                              )}
                          </div>
                          <p className="mt-1 text-[10px] leading-normal text-slate-500">
                            يرى الطبيب مستحقاته وعمولاته الشخصية فقط. أسعار التكلفة والمصروفات والأرباح وإيرادات المركز مخفية تماماً.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setEditForm((c) => ({
                              ...c,
                              permissions: {
                                ...c.permissions,
                                financialScope: "clinic_and_own",
                                canViewClinicRevenue: true,
                                canViewClinicFinance: true,
                                canViewCostPrices: true,
                                canViewExpenses: true,
                                canViewClinicProfits: true,
                              },
                            }));
                          }}
                          className={`rounded-xl border p-3 text-right transition-all ${
                            editForm.permissions.financialScope === "clinic_and_own" ||
                            editForm.permissions.canViewClinicRevenue ||
                            editForm.permissions.canViewClinicFinance
                              ? "border-blue-600 bg-white text-blue-950 shadow-sm ring-2 ring-blue-500/20"
                              : "border-slate-200 bg-slate-50/50 text-slate-600 hover:bg-white"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-black text-blue-900">
                              👁️ كشف إيرادات ومالية المركز بالكامل
                            </span>
                            {(editForm.permissions.financialScope === "clinic_and_own" ||
                              editForm.permissions.canViewClinicRevenue ||
                              editForm.permissions.canViewClinicFinance) && (
                              <span className="rounded-md bg-blue-100 px-1.5 py-0.5 text-[10px] font-extrabold text-blue-800">
                                ✓ نشط
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[10px] leading-normal text-slate-500">
                            كشف إيرادات المركز والتقارير التنفيذية (للأطباء الشركاء أو المشرفين الإداريين).
                          </p>
                        </button>
                      </div>

                      {/* Granular Privacy Toggles */}
                      <div className="mt-3.5 space-y-2 rounded-xl border border-amber-200/80 bg-white p-3.5">
                        <div className="mb-1 text-[11px] font-black text-slate-700">
                          التحكم التفصيلي ببنود الخصوصية والتكاليف (مفاتيح تشغيل/إيقاف):
                        </div>

                        {/* canViewCostPrices */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewCostPrices: !c.permissions.canViewCostPrices },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewCostPrices: !c.permissions.canViewCostPrices },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            !editForm.permissions.canViewCostPrices
                              ? "border-amber-300 bg-amber-50/40"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                أسعار التكلفة للمواد والمستلزمات وفواتير المعامل
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  !editForm.permissions.canViewCostPrices
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-blue-100 text-blue-800"
                                }`}
                              >
                                {!editForm.permissions.canViewCostPrices ? "🔒 مخفية عن الطبيب" : "👁️ مكشوفة"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              تمنع الطبيب من معرفة تكلفة شراء الحشوات والزرعات وفواتير المختبرات
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={!editForm.permissions.canViewCostPrices}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              !editForm.permissions.canViewCostPrices ? "bg-amber-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                !editForm.permissions.canViewCostPrices ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewExpenses */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewExpenses: !c.permissions.canViewExpenses },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewExpenses: !c.permissions.canViewExpenses },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            !editForm.permissions.canViewExpenses
                              ? "border-amber-300 bg-amber-50/40"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                المصروفات العامة وبنود الصرف والتشغيل
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  !editForm.permissions.canViewExpenses
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-blue-100 text-blue-800"
                                }`}
                              >
                                {!editForm.permissions.canViewExpenses ? "🔒 مخفية عن الطبيب" : "👁️ مكشوفة"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              حجب فواتير الإيجار والكهرباء والرواتب والمصروفات النثرية للمركز
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={!editForm.permissions.canViewExpenses}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              !editForm.permissions.canViewExpenses ? "bg-amber-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                !editForm.permissions.canViewExpenses ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewClinicProfits */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewClinicProfits: !c.permissions.canViewClinicProfits },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewClinicProfits: !c.permissions.canViewClinicProfits },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            !editForm.permissions.canViewClinicProfits
                              ? "border-amber-300 bg-amber-50/40"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                الأرباح العامة وصافي الدخل ومؤشرات الإدارة
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  !editForm.permissions.canViewClinicProfits
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-blue-100 text-blue-800"
                                }`}
                              >
                                {!editForm.permissions.canViewClinicProfits ? "🔒 مخفية عن الطبيب" : "👁️ مكشوفة"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              حجب لوحة قيادة الأرباح والتقارير التنفيذية الإجمالية للمركز
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={!editForm.permissions.canViewClinicProfits}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              !editForm.permissions.canViewClinicProfits ? "bg-amber-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                !editForm.permissions.canViewClinicProfits ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewOtherDoctorsAccounts */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewOtherDoctorsAccounts: !c.permissions.canViewOtherDoctorsAccounts },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewOtherDoctorsAccounts: !c.permissions.canViewOtherDoctorsAccounts },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            !editForm.permissions.canViewOtherDoctorsAccounts
                              ? "border-amber-300 bg-amber-50/40"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                حسابات وأتعاب الأطباء الآخرين في المركز
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  !editForm.permissions.canViewOtherDoctorsAccounts
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-blue-100 text-blue-800"
                                }`}
                              >
                                {!editForm.permissions.canViewOtherDoctorsAccounts ? "🔒 مخفية عن الطبيب" : "👁️ مكشوفة"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              لا يرى الطبيب سوى عمولاته ومستحقاته الشخصية فقط
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={!editForm.permissions.canViewOtherDoctorsAccounts}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              !editForm.permissions.canViewOtherDoctorsAccounts ? "bg-amber-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                !editForm.permissions.canViewOtherDoctorsAccounts ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewOwnCommissions */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewOwnCommissions: !c.permissions.canViewOwnCommissions },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewOwnCommissions: !c.permissions.canViewOwnCommissions },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            editForm.permissions.canViewOwnCommissions
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                الاطلاع على مستحقاته وعمولاته الشخصية وتقارير أتعابه
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewOwnCommissions
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewOwnCommissions ? "✓ مفعّل" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              تمكين الطبيب من مراجعة كشف حساب أتعابه وجدول عمولاته لحالاته المعالجة
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewOwnCommissions}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewOwnCommissions ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewOwnCommissions ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewServicePrices */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewServicePrices: !c.permissions.canViewServicePrices },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewServicePrices: !c.permissions.canViewServicePrices },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            editForm.permissions.canViewServicePrices
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                الاطلاع على لائحة أسعار الخدمات الرسمية
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewServicePrices
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewServicePrices ? "✓ مفعّل" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              معرفة الأسعار المعتمدة للخدمات والإجراءات السنية في الدليل
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewServicePrices}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewServicePrices ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewServicePrices ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewPatientPayments */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewPatientPayments: !c.permissions.canViewPatientPayments },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewPatientPayments: !c.permissions.canViewPatientPayments },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            editForm.permissions.canViewPatientPayments
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                الاطلاع على مدفوعات وفواتير المرضى وسجل الحساب
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewPatientPayments
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewPatientPayments ? "✓ مفعّل" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              كشف سندات القبض والدفعات المسددة والمتبقية على ملف المريض
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewPatientPayments}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewPatientPayments ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewPatientPayments ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>

                        {/* canViewCashDrawer */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              permissions: { ...c.permissions, canViewCashDrawer: !c.permissions.canViewCashDrawer },
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              setEditForm((c) => ({
                                ...c,
                                permissions: { ...c.permissions, canViewCashDrawer: !c.permissions.canViewCashDrawer },
                              }));
                            }
                          }}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 transition-all ${
                            editForm.permissions.canViewCashDrawer
                              ? "border-blue-300 bg-blue-50/50"
                              : "border-slate-200 bg-slate-50/40 hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">
                                استعراض الصندوق والورديات اليومية
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                                  editForm.permissions.canViewCashDrawer
                                    ? "bg-blue-100 text-blue-800"
                                    : "bg-slate-200 text-slate-600"
                                }`}
                              >
                                {editForm.permissions.canViewCashDrawer ? "✓ مفعّل" : "✕ معطّل"}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">
                              السماح بمشاهدة مبالغ الصندوق والورديات وحركات النقد
                            </p>
                          </div>
                          <div
                            role="switch"
                            aria-checked={editForm.permissions.canViewCashDrawer}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                              editForm.permissions.canViewCashDrawer ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                                editForm.permissions.canViewCashDrawer ? "translate-x-0 -translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Commission & Rates Configuration */}
              {activeEditorTab === "commission" && (
                <div className="space-y-4">
                  {/* Calculation Mode */}
                  <div>
                    <label className="mb-1.5 block font-black text-navy-900">
                      طريقة احتساب مستحقات الطبيب
                    </label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {[
                        { id: "percentage", label: "نسبة عامة موحدة (%)", hint: "نسبة ثابتة على كافة الخدمات والزيارات" },
                        { id: "by_category", label: "نِسب متغيرة حسب التخصص والخدمة", hint: "نسبة مختلفة للتقويم والزراعة والعصب والحشوات..." },
                        { id: "fixed", label: "مبلغ مقطوع ثابت", hint: "مبلغ محدد لكل إجراء أو جلسة علاج" },
                      ].map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() =>
                            setEditForm((c) => ({
                              ...c,
                              commissionConfig: {
                                ...c.commissionConfig,
                                calculationMode: mode.id as CommissionCalculationMode,
                              },
                            }))
                          }
                          className={`rounded-xl border p-3 text-right transition-all ${
                            editForm.commissionConfig.calculationMode === mode.id
                              ? "border-emerald-500 bg-emerald-50/70 font-bold text-emerald-950 shadow-xs"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          <div className="text-xs font-extrabold">{mode.label}</div>
                          <div className="mt-0.5 text-[10px] text-slate-500">{mode.hint}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Mode 1: Uniform Percentage */}
                  {editForm.commissionConfig.calculationMode === "percentage" && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                      <label className="mb-1 block font-bold text-slate-800">النسبة المئوية العامة للطبيب</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={editForm.commissionConfig.defaultPercent}
                          onChange={(e) =>
                            setEditForm((c) => ({
                              ...c,
                              commissionConfig: {
                                ...c.commissionConfig,
                                defaultPercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                              },
                            }))
                          }
                          className="w-28 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-black text-navy-900"
                        />
                        <span className="text-xs text-slate-600">% من الإيراد الصافي</span>
                      </div>
                    </div>
                  )}

                  {/* Mode 2: By Service Category */}
                  {editForm.commissionConfig.calculationMode === "by_category" && (
                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h4 className="font-black text-navy-900">نِسب الطبيب حسب أقسام الخدمات السنية</h4>
                        <span className="text-[11px] text-slate-500">حدد نسبة مئوية لكل تخصص</span>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        {DENTAL_SERVICE_CATEGORIES.map((cat) => {
                          const currentVal =
                            editForm.commissionConfig.categoryRates[cat.key] ??
                            editForm.commissionConfig.defaultPercent ??
                            cat.defaultPercent;

                          return (
                            <div
                              key={cat.key}
                              className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2"
                            >
                              <span className="font-bold text-slate-800">{cat.label}</span>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={currentVal}
                                  onChange={(e) => {
                                    const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                                    setEditForm((c) => ({
                                      ...c,
                                      commissionConfig: {
                                        ...c.commissionConfig,
                                        categoryRates: {
                                          ...c.commissionConfig.categoryRates,
                                          [cat.key]: val,
                                        },
                                      },
                                    }));
                                  }}
                                  className="w-16 rounded-lg border border-slate-200 bg-white px-2 py-1 text-center font-bold text-navy-900"
                                />
                                <span className="text-[11px] text-slate-400">%</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Mode 3: Fixed Amount */}
                  {editForm.commissionConfig.calculationMode === "fixed" && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                      <label className="mb-1 block font-bold text-slate-800">
                        المبلغ المقطوع لكل زيارة / إجراء (بالريال)
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={0}
                          value={Math.round((editForm.commissionConfig.fixedAmountPerVisitMinor || 0) / 100)}
                          onChange={(e) =>
                            setEditForm((c) => ({
                              ...c,
                              commissionConfig: {
                                ...c.commissionConfig,
                                fixedAmountPerVisitMinor: Math.max(0, Number(e.target.value) || 0) * 100,
                              },
                            }))
                          }
                          className="w-36 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-black text-navy-900"
                        />
                        <span className="text-xs text-slate-600">ريال يمني</span>
                      </div>
                    </div>
                  )}

                  {/* Section: Custom Service Rates (النسب المخصصة لخدمات وإجراءات معينة كـ التقويم والزراعة) */}
                  <div className="rounded-2xl border-2 border-emerald-500/20 bg-gradient-to-b from-emerald-50/40 via-white to-white p-4.5 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-100 pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-sm text-white shadow-xs">
                            🎯
                          </span>
                          <h4 className="text-sm font-black text-navy-900">
                            نسب خاصة لخدمات وإجراءات معينة (مثل التقويم أو الزراعة)
                          </h4>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-600">
                          تمنح هذه النسب استثناءً وأولوية قصوى على النسبة العامة عندما يؤدي الطبيب هذا الإجراء
                          المحدد في الفاتورة.
                        </p>
                      </div>
                      <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                        {editForm.commissionConfig.customServiceRates?.length || 0} نسب خاصة مضافة
                      </span>
                    </div>

                    {/* Quick Suggestions Chips */}
                    <div className="mt-3">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-extrabold text-slate-600">
                          ⚡ إضافة سريعة لأشهر الإجراءات التخصصية بنقرة واحدة:
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          { name: "تقويم الأسنان", percent: 35, category: "ortho", icon: "🦷" },
                          { name: "زراعة الأسنان", percent: 35, category: "implant", icon: "🔩" },
                          { name: "ابتسامة هوليوود / فينير", percent: 30, category: "cosmetic", icon: "✨" },
                          { name: "علاج الجذور والعصب بالمجهر", percent: 35, category: "endo", icon: "🔬" },
                          { name: "خلع جراحي لضرس العقل", percent: 35, category: "surgery", icon: "🔪" },
                          { name: "تبييض الأسنان بالليزر", percent: 30, category: "cosmetic", icon: "💎" },
                        ].map((preset) => {
                          const isAlreadyAdded = (editForm.commissionConfig.customServiceRates ?? []).some(
                            (r) => r.serviceName.trim().toLowerCase() === preset.name.toLowerCase(),
                          );
                          return (
                            <button
                              key={preset.name}
                              type="button"
                              onClick={() => {
                                handleAddSpecialRate({
                                  name: preset.name,
                                  percent: preset.percent,
                                  category: preset.category,
                                });
                              }}
                              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-all ${
                                isAlreadyAdded
                                  ? "border-emerald-300 bg-emerald-100 text-emerald-900 cursor-default opacity-80"
                                  : "border-slate-200 bg-white text-slate-700 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-950"
                              }`}
                            >
                              <span>{preset.icon}</span>
                              <span>{preset.name}</span>
                              <span className="rounded bg-slate-100 px-1 py-0.2 text-[10px] font-extrabold text-slate-700">
                                {preset.percent}%
                              </span>
                              {isAlreadyAdded ? (
                                <span className="text-[10px] text-emerald-700 font-extrabold">✓</span>
                              ) : (
                                <span className="text-slate-400">+</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* New Rate Form */}
                    <div className="mt-4 rounded-xl border border-emerald-200/80 bg-emerald-50/30 p-3.5">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-black text-emerald-950">
                          ➕ نموذج تخصيص نسبة لخدمة محددة
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setNewSpecialRate((c) => ({
                                ...c,
                                serviceMode: "from_list",
                                serviceId: null,
                                serviceName: "",
                              }))
                            }
                            className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors ${
                              newSpecialRate.serviceMode === "from_list"
                                ? "bg-emerald-600 text-white"
                                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            }`}
                          >
                            من قائمة المركز
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setNewSpecialRate((c) => ({
                                ...c,
                                serviceMode: "custom_text",
                                serviceId: null,
                                serviceName: "",
                              }))
                            }
                            className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors ${
                              newSpecialRate.serviceMode === "custom_text"
                                ? "bg-emerald-600 text-white"
                                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            }`}
                          >
                            كتابة إجراء خاص
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
                        {/* Service Selection / Text Input */}
                        <div className="sm:col-span-5">
                          <label className="mb-1 block text-[11px] font-bold text-slate-700">
                            اسم الخدمة أو الإجراء
                          </label>
                          {newSpecialRate.serviceMode === "from_list" && clinicServices.length > 0 ? (
                            <select
                              value={newSpecialRate.serviceId ? String(newSpecialRate.serviceId) : ""}
                              onChange={(e) => {
                                const sId = Number(e.target.value);
                                const found = clinicServices.find((s) => s.id === sId);
                                if (found) {
                                  setNewSpecialRate((c) => ({
                                    ...c,
                                    serviceId: found.id,
                                    serviceName: found.name,
                                    category: found.category || c.category,
                                  }));
                                } else {
                                  setNewSpecialRate((c) => ({
                                    ...c,
                                    serviceId: null,
                                    serviceName: "",
                                  }));
                                }
                              }}
                              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-navy-900"
                            >
                              <option value="">-- اختر خدمة من المركز --</option>
                              {clinicServices.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} {s.category ? `(${s.category})` : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={newSpecialRate.serviceName}
                              onChange={(e) =>
                                setNewSpecialRate((c) => ({ ...c, serviceName: e.target.value }))
                              }
                              placeholder="مثال: تقويم الأسنان، زراعة الغرسة السويسرية..."
                              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-navy-900 placeholder:text-slate-400"
                            />
                          )}
                        </div>

                        {/* Special Percent Input */}
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[11px] font-bold text-slate-700">
                            النسبة الخاصة (%)
                          </label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={newSpecialRate.percent}
                              onChange={(e) =>
                                setNewSpecialRate((c) => ({
                                  ...c,
                                  percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                                }))
                              }
                              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-center text-xs font-black text-emerald-950"
                            />
                            <span className="text-xs font-bold text-slate-500">%</span>
                          </div>
                        </div>

                        {/* Category Tag */}
                        <div className="sm:col-span-3">
                          <label className="mb-1 block text-[11px] font-bold text-slate-700">
                            التصنيف الطبي
                          </label>
                          <select
                            value={newSpecialRate.category}
                            onChange={(e) =>
                              setNewSpecialRate((c) => ({ ...c, category: e.target.value }))
                            }
                            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-800"
                          >
                            <option value="ortho">🦷 تقويم الأسنان</option>
                            <option value="implant">🔩 زراعة الأسنان</option>
                            <option value="surgery">🔪 جراحة الوجه والفكين</option>
                            <option value="endo">🔬 علاج الجذور والعصب</option>
                            <option value="prostho">👑 تركيبات واستعاضة</option>
                            <option value="cosmetic">✨ تجميل وابتسامة هوليوود</option>
                            <option value="pedo">👶 طب أسنان الأطفال</option>
                            <option value="perio">🛡️ أمراض وجراحة اللثة</option>
                            <option value="restorative">✨ حشوات وترميم</option>
                            <option value="general">📋 خدمات عامة</option>
                          </select>
                        </div>

                        {/* Submit Button */}
                        <div className="flex items-end sm:col-span-2">
                          <button
                            type="button"
                            onClick={() => handleAddSpecialRate()}
                            disabled={!newSpecialRate.serviceName.trim()}
                            className="w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-extrabold text-white shadow-xs transition-all hover:bg-emerald-700 disabled:opacity-40"
                          >
                            + إضافة النسبة
                          </button>
                        </div>
                      </div>

                      {/* Optional Note */}
                      <div className="mt-2">
                        <input
                          type="text"
                          value={newSpecialRate.note}
                          onChange={(e) =>
                            setNewSpecialRate((c) => ({ ...c, note: e.target.value }))
                          }
                          placeholder="ملاحظات اختيارية (مثال: تشمل جلسات الشد والمتابعة، أو بعد خصم الأدوات)"
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 placeholder:text-slate-400"
                        />
                      </div>
                    </div>

                    {/* Active Custom Service Rates Table / List */}
                    <div className="mt-4">
                      <h5 className="mb-2 text-xs font-black text-navy-900">
                        📋 جدول النسب الخاصة المعتمدة لهذا الطبيب:
                      </h5>

                      {(!editForm.commissionConfig.customServiceRates ||
                        editForm.commissionConfig.customServiceRates.length === 0) ? (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-5 text-center text-xs text-slate-500">
                          <p className="font-bold text-slate-600">
                            لا توجد نسب خاصة مضافة حتى الآن لهذا الطبيب.
                          </p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            سيتم احتساب جميع أعماله بناءً على النسبة العامة ({editForm.commissionConfig.defaultPercent}%)
                            أو الأقسام المحددة أعلاه. أضف نسبة خاصة للتقويم أو الزراعة لتطبيقها بدلاً من النسبة العامة.
                          </p>
                        </div>
                      ) : (
                        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
                          <table className="w-full text-right text-xs">
                            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-extrabold text-slate-700">
                              <tr>
                                <th className="p-2.5">الخدمة / الإجراء</th>
                                <th className="p-2.5">التصنيف</th>
                                <th className="p-2.5 text-center">النسبة المخصصة</th>
                                <th className="p-2.5">الفارق عن العامة</th>
                                <th className="p-2.5">ملاحظات</th>
                                <th className="p-2.5 text-center">إجراءات</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {editForm.commissionConfig.customServiceRates.map((rate) => {
                                const diff = rate.percent - (editForm.commissionConfig.defaultPercent || 0);
                                return (
                                  <tr key={rate.id} className="hover:bg-slate-50/80">
                                    <td className="p-2.5 font-bold text-navy-900">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-emerald-700">🎯</span>
                                        <span>{rate.serviceName}</span>
                                      </div>
                                    </td>
                                    <td className="p-2.5">
                                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                                        {rate.category === "ortho"
                                          ? "تقويم أسنان"
                                          : rate.category === "implant"
                                          ? "زراعة أسنان"
                                          : rate.category === "surgery"
                                          ? "جراحة"
                                          : rate.category === "endo"
                                          ? "علاج عصب"
                                          : rate.category === "cosmetic"
                                          ? "تجميل وفينير"
                                          : rate.category === "prostho"
                                          ? "تركيبات"
                                          : rate.category || "عام"}
                                      </span>
                                    </td>
                                    <td className="p-2.5 text-center">
                                      <div className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1">
                                        <input
                                          type="number"
                                          min={0}
                                          max={100}
                                          value={rate.percent}
                                          onChange={(e) =>
                                            handleUpdateSpecialRatePercent(
                                              rate.id,
                                              Number(e.target.value) || 0,
                                            )
                                          }
                                          className="w-12 bg-transparent text-center font-black text-emerald-950 focus:outline-none"
                                        />
                                        <span className="text-[11px] font-extrabold text-emerald-800">%</span>
                                      </div>
                                    </td>
                                    <td className="p-2.5">
                                      {diff > 0 ? (
                                        <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-extrabold text-emerald-900">
                                          +{diff}% أزيد من العامة
                                        </span>
                                      ) : diff < 0 ? (
                                        <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-900">
                                          {diff}% أقل من العامة
                                        </span>
                                      ) : (
                                        <span className="text-[10px] text-slate-400">مماثلة للعامة</span>
                                      )}
                                    </td>
                                    <td className="p-2.5 text-[11px] text-slate-500">
                                      {rate.note || "—"}
                                    </td>
                                    <td className="p-2.5 text-center">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleRemoveSpecialRate(
                                            rate.id,
                                            rate.serviceName,
                                            rate.serviceId,
                                          )
                                        }
                                        title="حذف هذه النسبة الخاصة"
                                        className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                      >
                                        🗑️
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Deduction & Basis Options */}
                  <div className="space-y-2 rounded-xl border border-slate-200 p-4">
                    <h4 className="mb-2 font-black text-navy-900">خيارات الخصم وأساس الصرف</h4>

                    <label className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                      <div>
                        <div className="font-bold text-slate-800">
                          خصم تكلفة المعمل أولاً قبل احتساب نسبة الطبيب
                        </div>
                        <div className="text-[10px] text-slate-400">
                          (إجمالي الفاتورة - تكلفة المعمل) × نسبة الطبيب = الاستحقاق العادل
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={editForm.commissionConfig.deductLabCost}
                        onChange={(e) =>
                          setEditForm((c) => ({
                            ...c,
                            commissionConfig: {
                              ...c.commissionConfig,
                              deductLabCost: e.target.checked,
                            },
                          }))
                        }
                        className="h-4 w-4 rounded accent-brand-blue"
                      />
                    </label>

                    <div className="pt-2">
                      <label className="mb-1.5 block font-bold text-slate-800">أساس احتساب الصرف</label>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { id: "collected_cash", label: "على التحصيل الفعلي فقط (الافتراضي العادل)", hint: "لا عمولة على فاتورة لم تُحصّل" },
                          { id: "invoiced", label: "على إجمالي الفواتير الصادرة", hint: "يُحسب الاستحقاق بمجرد إصدار الفاتورة" },
                        ].map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() =>
                              setEditForm((c) => ({
                                ...c,
                                commissionConfig: {
                                  ...c.commissionConfig,
                                  basis: b.id as "collected_cash" | "invoiced",
                                },
                              }))
                            }
                            className={`flex-1 rounded-xl border p-2.5 text-right text-xs ${
                              editForm.commissionConfig.basis === b.id
                                ? "border-emerald-500 bg-emerald-50 font-bold text-emerald-950"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            <div>{b.label}</div>
                            <div className="text-[10px] text-slate-400">{b.hint}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-slate-200 p-4">
              <button
                type="button"
                onClick={() => setEditingUser(null)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                إغلاق
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={busy}
                className="rounded-xl bg-brand-blue px-6 py-2 text-xs font-extrabold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "جارٍ الحفظ..." : "حفظ التغييرات والصلاحيات"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
