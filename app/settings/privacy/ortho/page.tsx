"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Plus, Save, Shield, Trash2, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/roles";
import {
  ORTHO_FIELD_LABELS,
  ORTHO_FIELDS,
  ORTHO_PERMISSION_META,
  ORTHO_PERMISSIONS,
  ORTHO_SECTION_LABELS,
  ORTHO_SECTIONS,
  OWNER_ONLY_ORTHO_PERMISSIONS,
  resolveOrthoAccess,
  type OrthoFieldKey,
  type OrthoPermissionKey,
  type OrthoPrivacyPolicyDocument,
  type OrthoPrivacyRule,
  type OrthoSectionKey,
} from "@/lib/ortho-privacy";

interface StaffSummary {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  branch: string | null;
  partyId: number | null;
}

interface PrivacyPayload {
  policy: OrthoPrivacyPolicyDocument;
  actor: { userId: number; isOwner: boolean; isDelegatedManager: boolean };
  staff: StaffSummary[];
}

const GROUP_LABELS: Record<"access" | "records" | "media" | "clinical" | "governance", string> = {
  access: "ظهور الوحدة والوصول العام",
  records: "قراءة وإدخال وتعديل وحذف السجلات",
  media: "التصوير والصور والأشعة",
  clinical: "القياسات والتشخيص والخطة والشدّات والتقارير",
  governance: "المساعد الذكي والمالية وإعدادات الوحدة",
};

export default function OrthoPrivacySettingsPage() {
  const [data, setData] = useState<PrivacyPayload | null>(null);
  const [draft, setDraft] = useState<OrthoPrivacyPolicyDocument | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>("doctor");
  const [saveReason, setSaveReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Rule builder states
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleEffect, setRuleEffect] = useState<"allow" | "deny">("deny");
  const [ruleUserId, setRuleUserId] = useState("");
  const [ruleRole, setRuleRole] = useState<"" | Role>("");
  const [ruleBranch, setRuleBranch] = useState("");
  const [rulePatientId, setRulePatientId] = useState("");
  const [ruleCaseId, setRuleCaseId] = useState("");
  const [ruleDoctorPartyId, setRuleDoctorPartyId] = useState("");
  const [ruleExpiresAt, setRuleExpiresAt] = useState("");
  const [ruleReason, setRuleReason] = useState("");
  const [rulePermissions, setRulePermissions] = useState<OrthoPermissionKey[]>(["module.visible"]);
  const [ruleSections, setRuleSections] = useState<OrthoSectionKey[]>([]);
  const [ruleFields, setRuleFields] = useState<OrthoFieldKey[]>([]);

  // Live effective simulator
  const [simUserId, setSimUserId] = useState<string>("");
  const [simPatientId, setSimPatientId] = useState<string>("");
  const [simCaseId, setSimCaseId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/ortho-privacy", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as PrivacyPayload & { message?: string };
      if (!res.ok) {
        setError(payload.message || "غير مصرّح لك بفتح إعدادات خصوصية وحدة التقويم.");
        setData(null);
        setDraft(null);
        return;
      }
      setData(payload);
      setDraft(payload.policy);
      if (payload.staff.length > 0 && !simUserId) {
        const firstNonOwner = payload.staff.find((s) => s.id !== payload.policy.ownerUserId) ?? payload.staff[0];
        setSimUserId(String(firstNonOwner.id));
      }
    } catch {
      setError("تعذّر الاتصال بالخادم لتحميل سياسة الخصوصية.");
    } finally {
      setLoading(false);
    }
  }, [simUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = Boolean(data?.actor.isOwner);

  const toggleRolePermission = (role: Role, key: OrthoPermissionKey) => {
    if (!draft) return;
    if (role === "admin" && !isOwner) return;
    if (OWNER_ONLY_ORTHO_PERMISSIONS.has(key) && !isOwner) return;
    const currentVal = Boolean(draft.roleDefaults[role]?.permissions?.[key]);
    setDraft({
      ...draft,
      roleDefaults: {
        ...draft.roleDefaults,
        [role]: {
          ...draft.roleDefaults[role],
          permissions: {
            ...draft.roleDefaults[role].permissions,
            [key]: !currentVal,
          },
        },
      },
    });
  };

  const toggleRoleSection = (role: Role, key: OrthoSectionKey) => {
    if (!draft) return;
    if (role === "admin" && !isOwner) return;
    const currentVal = Boolean(draft.roleDefaults[role]?.sections?.[key]);
    setDraft({
      ...draft,
      roleDefaults: {
        ...draft.roleDefaults,
        [role]: {
          ...draft.roleDefaults[role],
          sections: {
            ...draft.roleDefaults[role].sections,
            [key]: !currentVal,
          },
        },
      },
    });
  };

  const toggleRoleField = (role: Role, key: OrthoFieldKey) => {
    if (!draft) return;
    if (role === "admin" && !isOwner) return;
    const currentVal = Boolean(draft.roleDefaults[role]?.fields?.[key]);
    setDraft({
      ...draft,
      roleDefaults: {
        ...draft.roleDefaults,
        [role]: {
          ...draft.roleDefaults[role],
          fields: {
            ...draft.roleDefaults[role].fields,
            [key]: !currentVal,
          },
        },
      },
    });
  };

  const toggleDelegatedManager = (userId: number) => {
    if (!draft || !isOwner) return;
    const exists = draft.delegatedManagerUserIds.includes(userId);
    setDraft({
      ...draft,
      delegatedManagerUserIds: exists
        ? draft.delegatedManagerUserIds.filter((id) => id !== userId)
        : [...draft.delegatedManagerUserIds, userId],
    });
  };

  const addScopedRule = () => {
    if (!draft) return;
    setError("");
    const target: OrthoPrivacyRule["target"] = {};
    if (ruleRole) target.roles = [ruleRole];
    if (ruleUserId && Number(ruleUserId) > 0) target.userIds = [Number(ruleUserId)];
    if (ruleBranch.trim()) target.branches = [ruleBranch.trim()];
    if (rulePatientId && Number(rulePatientId) > 0) target.patientIds = [Number(rulePatientId)];
    if (ruleCaseId && Number(ruleCaseId) > 0) target.orthoCaseIds = [Number(ruleCaseId)];
    if (ruleDoctorPartyId && Number(ruleDoctorPartyId) > 0) target.doctorPartyIds = [Number(ruleDoctorPartyId)];

    if (Object.keys(target).length === 0) {
      setError("حدد نطاقًا واحدًا على الأقل للقاعدة (موظف أو دور أو فرع أو مريض أو حالة أو طبيب).");
      return;
    }
    if (rulePermissions.length === 0 && ruleSections.length === 0 && ruleFields.length === 0) {
      setError("اختر عملية أو قسمًا أو حقلًا واحدًا على الأقل للقاعدة.");
      return;
    }

    const nextRule: OrthoPrivacyRule = {
      id: `ortho-rule-${Date.now()}`,
      label: ruleLabel.trim() || (ruleEffect === "deny" ? "قاعدة منع صريح" : "قاعدة سماح مقيدة"),
      effect: ruleEffect,
      target,
      ...(rulePermissions.length > 0 ? { permissions: rulePermissions } : {}),
      ...(ruleSections.length > 0 ? { sections: ruleSections } : {}),
      ...(ruleFields.length > 0 ? { fields: ruleFields } : {}),
      expiresAt: ruleExpiresAt ? new Date(ruleExpiresAt).toISOString() : null,
      reason: ruleReason.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    setDraft({ ...draft, rules: [nextRule, ...draft.rules] });
    setRuleLabel("");
    setRuleReason("");
    setRuleExpiresAt("");
  };

  const applyPreset = (preset: "blind_photo_assistant" | "hide_ortho_from_user" | "temp_24h_view") => {
    setRulePermissions([]);
    setRuleSections([]);
    setRuleFields([]);
    if (preset === "blind_photo_assistant") {
      setRuleEffect("allow");
      setRuleLabel("التقاط ورفع صور فقط (بلا استعراض السابق)");
      setRulePermissions(["module.visible", "records.blind_create", "photos.capture", "photos.upload"]);
      setRuleSections(["sessions"]);
      setRuleReason("تمكين التصوير الميداني دون كشف السجلات أو الصور السابقة");
    } else if (preset === "hide_ortho_from_user") {
      setRuleEffect("deny");
      setRuleLabel("حجب وحدة التقويم بالكامل");
      setRulePermissions(["module.visible"]);
      setRuleReason("منع ظهور وحدة التقويم وسجلاتها عن هذا المستخدم");
    } else {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      setRuleEffect("allow");
      setRuleLabel("صلاحية استعراض مؤقتة 24 ساعة");
      setRulePermissions(["module.visible", "records.read", "photos.view"]);
      setRuleSections(["overview", "media", "sessions"]);
      setRuleFields(["previousPhotos"]);
      setRuleExpiresAt(tomorrow.toISOString().slice(0, 16));
      setRuleReason("صلاحية مراجعة مؤقتة لمدة 24 ساعة");
    }
  };

  const handleSave = async () => {
    if (!draft || !data) return;
    setError("");
    setSuccess("");
    if (saveReason.trim().length < 3) {
      setError("أدخل سبب تعديل سياسة الصلاحيات لتوثيقه في سجل التدقيق (3 أحرف على الأقل).");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/ortho-privacy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: draft,
          expectedRevision: data.policy.revision,
          reason: saveReason.trim(),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { policy?: OrthoPrivacyPolicyDocument; message?: string };
      if (!res.ok || !payload.policy) {
        setError(payload.message || "تعذّر حفظ سياسة الصلاحيات.");
        return;
      }
      setData({ ...data, policy: payload.policy });
      setDraft(payload.policy);
      setSaveReason("");
      setSuccess(`تم حفظ سياسة الخصوصية والصلاحيات (الإصدار #${payload.policy.revision}) وتوثيقها في سجل التدقيق.`);
    } catch {
      setError("تعذّر الاتصال بالخادم أثناء حفظ السياسة.");
    } finally {
      setSaving(false);
    }
  };

  const simulatedAccess = useMemo(() => {
    if (!draft || !data) return null;
    const staff = data.staff.find((s) => String(s.id) === simUserId);
    if (!staff) return null;
    return {
      staff,
      access: resolveOrthoAccess(
        draft,
        {
          userId: staff.id,
          username: staff.username,
          role: staff.role,
          isActive: staff.isActive,
          branch: staff.branch,
          partyId: staff.partyId,
          isOwner: draft.ownerUserId === staff.id,
        },
        {
          patientId: simPatientId ? Number(simPatientId) : null,
          orthoCaseId: simCaseId ? Number(simCaseId) : null,
        },
      ),
    };
  }, [draft, data, simUserId, simPatientId, simCaseId]);

  const groupedPermissions = useMemo(() => {
    const groups: Record<"access" | "records" | "media" | "clinical" | "governance", OrthoPermissionKey[]> = {
      access: [],
      records: [],
      media: [],
      clinical: [],
      governance: [],
    };
    for (const key of ORTHO_PERMISSIONS) {
      groups[ORTHO_PERMISSION_META[key].group].push(key);
    }
    return groups;
  }, []);

  return (
    <div className="space-y-6 pb-12" dir="rtl">
      <PageHeader
        title="الخصوصية والصلاحيات — وحدة التقويم"
        subtitle="الإعدادات ← الخصوصية والصلاحيات ← وحدة التقويم · المنع الصريح يتقدم على السماح، والافتراضي هو المنع، والفحص يُنفَّذ على الخادم عند كل طلب."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Link href="/settings" className="font-semibold text-brand-blue hover:underline">
            الإعدادات
          </Link>
          <span>←</span>
          <span>الخصوصية والصلاحيات</span>
          <span>←</span>
          <span className="font-bold text-slate-900">وحدة التقويم</span>
        </div>
        {data && (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            إصدار السياسة: #{data.policy.revision} · {isOwner ? "صلاحية المالك" : "مدير مفوض (حدود مقيدة)"}
          </span>
        )}
      </div>

      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          جاري تحميل سياسة خصوصية وصلاحيات وحدة التقويم...
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {draft && data && (
        <>
          {/* Save Bar */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  سبب تعديل الصلاحيات (إلزامي للتوثيق غير القابل للتعديل في سجل التدقيق)
                </label>
                <input
                  type="text"
                  value={saveReason}
                  onChange={(e) => setSaveReason(e.target.value)}
                  placeholder="مثال: منح المساعد صلاحية تصوير الشدّات فقط دون رؤية الصور السابقة أو التشخيص..."
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-brand-blue"
                />
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-navy px-5 py-2.5 text-sm font-bold text-white hover:opacity-95 disabled:opacity-50 md:mt-5"
              >
                <Save className="h-4 w-4" />
                <span>{saving ? "جاري الحفظ..." : "حفظ السياسة في الخادم"}</span>
              </button>
            </div>
          </div>

          {/* 1. Role Defaults Matrix */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-brand-blue" />
                <div>
                  <h2 className="text-base font-bold text-slate-900">1. الصلاحيات الافتراضية حسب الدور</h2>
                  <p className="text-xs text-slate-500">
                    اختر الدور لتحديد العمليات الـ 26 والأقسام الـ 16 والحقول الحساسة المسموحة له افتراضيًا.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {ROLES.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setSelectedRole(role)}
                    className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition ${
                      selectedRole === role
                        ? "bg-brand-navy text-white shadow-sm"
                        : "border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {ROLE_LABEL[role]}
                  </button>
                ))}
              </div>
            </div>

            {/* Operations by Group */}
            <div className="space-y-4">
              {(Object.keys(GROUP_LABELS) as Array<keyof typeof GROUP_LABELS>).map((grp) => (
                <div key={grp} className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-700">{GROUP_LABELS[grp]}</h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {groupedPermissions[grp].map((perm) => {
                      const meta = ORTHO_PERMISSION_META[perm];
                      const checked = Boolean(draft.roleDefaults[selectedRole]?.permissions?.[perm]);
                      const locked = (selectedRole === "admin" && !isOwner) || (OWNER_ONLY_ORTHO_PERMISSIONS.has(perm) && !isOwner);
                      return (
                        <label
                          key={perm}
                          className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs transition ${
                            checked ? "border-brand-blue/40 bg-brand-blue/5" : "border-slate-200 bg-white"
                          } ${locked ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-slate-50"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked}
                            onChange={() => toggleRolePermission(selectedRole, perm)}
                            className="mt-0.5 h-4 w-4 accent-brand-blue"
                          />
                          <div>
                            <div className="font-semibold text-slate-900">{meta.labelAr}</div>
                            <div className="font-mono text-[10px] text-slate-400">{perm}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Sub-sections & Tabs */}
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-bold text-slate-700">التبويبات والأقسام الفرعية المسموح بفتحها لدور ({ROLE_LABEL[selectedRole]})</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {ORTHO_SECTIONS.map((sec) => {
                  const checked = Boolean(draft.roleDefaults[selectedRole]?.sections?.[sec]);
                  const locked = selectedRole === "admin" && !isOwner;
                  return (
                    <label
                      key={sec}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                        checked ? "border-emerald-300 bg-emerald-50/70 text-emerald-950" : "border-slate-200 bg-white text-slate-700"
                      } ${locked ? "opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggleRoleSection(selectedRole, sec)}
                        className="h-3.5 w-3.5 accent-emerald-700"
                      />
                      <span className="font-medium">{ORTHO_SECTION_LABELS[sec]}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Sensitive Fields */}
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-bold text-slate-700">الحقول الحساسة المسموح بعرضها لدور ({ROLE_LABEL[selectedRole]})</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ORTHO_FIELDS.map((field) => {
                  const checked = Boolean(draft.roleDefaults[selectedRole]?.fields?.[field]);
                  const locked = selectedRole === "admin" && !isOwner;
                  return (
                    <label
                      key={field}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                        checked ? "border-amber-300 bg-amber-50/60 text-amber-950" : "border-slate-200 bg-white text-slate-700"
                      } ${locked ? "opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggleRoleField(selectedRole, field)}
                        className="h-3.5 w-3.5 accent-amber-700"
                      />
                      <span className="font-medium">{ORTHO_FIELD_LABELS[field]}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 2. Scoped Override & Temporary Grant Rules */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">2. القواعد الاستثنائية والصلاحيات المؤقتة (على مستوى الموظف / الفرع / الطبيب / الحالة / المريض)</h2>
                <p className="text-xs text-slate-500">
                  المنع الصريح (Deny) يتقدم دائمًا على أي سماح. الصلاحيات المؤقتة تنتهي تلقائيًا عند وقت الانتهاء.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => applyPreset("blind_photo_assistant")}
                  className="rounded-lg border border-brand-blue/30 bg-brand-blue/5 px-2.5 py-1.5 font-semibold text-brand-blue hover:bg-brand-blue/10"
                >
                  قالب: تصوير فقط بلا رؤية سابقة
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset("hide_ortho_from_user")}
                  className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100"
                >
                  قالب: إخفاء التقويم بالكامل
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset("temp_24h_view")}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-semibold text-amber-800 hover:bg-amber-100"
                >
                  قالب: صلاحية مؤقتة 24 ساعة
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">نوع القاعدة</label>
                <select
                  value={ruleEffect}
                  onChange={(e) => setRuleEffect(e.target.value as "allow" | "deny")}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                >
                  <option value="deny">منع صريح (Deny — يتقدم دائمًا)</option>
                  <option value="allow">سماح محدد (Allow)</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">موظف محدد (اختياري)</label>
                <select
                  value={ruleUserId}
                  onChange={(e) => setRuleUserId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                >
                  <option value="">— أي موظف —</option>
                  {data.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName} ({ROLE_LABEL[s.role]})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الدور (اختياري)</label>
                <select
                  value={ruleRole}
                  onChange={(e) => setRuleRole(e.target.value as "" | Role)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                >
                  <option value="">— أي دور —</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الفرع (اختياري)</label>
                <input
                  type="text"
                  value={ruleBranch}
                  onChange={(e) => setRuleBranch(e.target.value)}
                  placeholder="مثال: تعز — الرئيسي"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">رقم المريض (اختياري)</label>
                <input
                  type="number"
                  min={1}
                  value={rulePatientId}
                  onChange={(e) => setRulePatientId(e.target.value)}
                  placeholder="patientId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">رقم حالة التقويم (اختياري)</label>
                <input
                  type="number"
                  min={1}
                  value={ruleCaseId}
                  onChange={(e) => setRuleCaseId(e.target.value)}
                  placeholder="orthoCaseId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">معرّف الطبيب المسؤول (اختياري)</label>
                <input
                  type="number"
                  min={1}
                  value={ruleDoctorPartyId}
                  onChange={(e) => setRuleDoctorPartyId(e.target.value)}
                  placeholder="doctorPartyId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تاريخ انتهاء مؤقت (اختياري)</label>
                <input
                  type="datetime-local"
                  value={ruleExpiresAt}
                  onChange={(e) => setRuleExpiresAt(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">عنوان القاعدة</label>
                <input
                  type="text"
                  value={ruleLabel}
                  onChange={(e) => setRuleLabel(e.target.value)}
                  placeholder="مثال: منع د. فلان من وحدة التقويم"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب القاعدة (للتدقيق)</label>
                <input
                  type="text"
                  value={ruleReason}
                  onChange={(e) => setRuleReason(e.target.value)}
                  placeholder="مثال: تكليف مؤقت لتغطية حالة محددة"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <div className="font-semibold text-slate-700">العمليات المشمولة في القاعدة:</div>
              <div className="flex flex-wrap gap-1.5">
                {ORTHO_PERMISSIONS.filter((p) => isOwner || !OWNER_ONLY_ORTHO_PERMISSIONS.has(p)).map((perm) => {
                  const active = rulePermissions.includes(perm);
                  return (
                    <button
                      key={perm}
                      type="button"
                      onClick={() =>
                        setRulePermissions((prev) =>
                          prev.includes(perm) ? prev.filter((x) => x !== perm) : [...prev, perm],
                        )
                      }
                      className={`rounded-lg border px-2.5 py-1 font-medium transition ${
                        active
                          ? ruleEffect === "deny"
                            ? "border-red-500 bg-red-50 text-red-900"
                            : "border-emerald-500 bg-emerald-50 text-emerald-900"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {ORTHO_PERMISSION_META[perm].labelAr}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={addScopedRule}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand-blue px-4 py-2 text-xs font-bold text-white hover:opacity-95"
            >
              <Plus className="h-4 w-4" />
              <span>إضافة القاعدة إلى المسودة</span>
            </button>

            {/* Active Rules List */}
            {draft.rules.length > 0 && (
              <div className="space-y-2 pt-3 border-t border-slate-100">
                <h3 className="text-xs font-bold text-slate-700">القواعد النشطة والمؤقتة ({draft.rules.length})</h3>
                <div className="space-y-2">
                  {draft.rules.map((r) => {
                    const nowIso = new Date().toISOString();
                    const expired = Boolean(r.expiresAt && r.expiresAt <= nowIso);
                    return (
                      <div
                        key={r.id}
                        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-xs ${
                          expired
                            ? "border-slate-200 bg-slate-50 opacity-65"
                            : r.effect === "deny"
                            ? "border-red-200 bg-red-50/40"
                            : "border-emerald-200 bg-emerald-50/40"
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                r.effect === "deny" ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"
                              }`}
                            >
                              {r.effect === "deny" ? "منع صريح" : "سماح"}
                            </span>
                            <span className="font-bold text-slate-900">{r.label || r.id}</span>
                            {r.expiresAt && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
                                <Clock className="h-3 w-3" />
                                {expired ? "منتهية الصلاحية" : `تنتهي: ${r.expiresAt.slice(0, 16).replace("T", " ")}`}
                              </span>
                            )}
                          </div>
                          <div className="text-slate-600">
                            النطاق: {JSON.stringify(r.target)} · العمليات: {(r.permissions ?? []).join("، ") || "—"}
                          </div>
                          {r.reason && <div className="text-slate-500">السبب: {r.reason}</div>}
                        </div>
                        <button
                          type="button"
                          onClick={() => setDraft({ ...draft, rules: draft.rules.filter((x) => x.id !== r.id) })}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                          title="إزالة القاعدة"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* 3. Owner Delegation & Effective Simulator */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {isOwner && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
                <div className="flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-brand-orange" />
                  <h2 className="text-sm font-bold text-slate-900">3. تفويض محدود للمديرين (بيد المالك وحده)</h2>
                </div>
                <p className="text-xs text-slate-500">
                  يمكن للمدير المفوض إدارة صلاحيات الأطباء والمساعدين والاستقبال، لكنه لا يستطيع المساس بحساب المالك أو رفع صلاحياته أو تفويض غيره.
                </p>
                <div className="space-y-2">
                  {data.staff
                    .filter((s) => s.role === "admin" && s.id !== draft.ownerUserId)
                    .map((adminUser) => {
                      const delegated = draft.delegatedManagerUserIds.includes(adminUser.id);
                      return (
                        <label
                          key={adminUser.id}
                          className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-xs cursor-pointer hover:bg-slate-50"
                        >
                          <div>
                            <div className="font-bold text-slate-900">{adminUser.displayName}</div>
                            <div className="text-slate-500 font-mono">{adminUser.username}</div>
                          </div>
                          <input
                            type="checkbox"
                            checked={delegated}
                            onChange={() => toggleDelegatedManager(adminUser.id)}
                            className="h-4 w-4 accent-brand-blue"
                          />
                        </label>
                      );
                    })}
                  {data.staff.filter((s) => s.role === "admin" && s.id !== draft.ownerUserId).length === 0 && (
                    <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                      لا توجد حسابات مديرين أخرى غير حساب المالك حاليًا.
                    </div>
                  )}
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
              <h2 className="text-sm font-bold text-slate-900">4. معاينة الصلاحية الفعّالة قبل الحفظ (محاكي الخادم)</h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
                <select
                  value={simUserId}
                  onChange={(e) => setSimUserId(e.target.value)}
                  className="rounded-xl border border-slate-300 bg-white px-2.5 py-2"
                >
                  {data.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName} ({ROLE_LABEL[s.role]})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={simPatientId}
                  onChange={(e) => setSimPatientId(e.target.value)}
                  placeholder="رقم مريض (اختياري)"
                  className="rounded-xl border border-slate-300 px-2.5 py-2 font-mono"
                />
                <input
                  type="number"
                  min={1}
                  value={simCaseId}
                  onChange={(e) => setSimCaseId(e.target.value)}
                  placeholder="رقم حالة (اختياري)"
                  className="rounded-xl border border-slate-300 px-2.5 py-2 font-mono"
                />
              </div>

              {simulatedAccess && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">
                      {simulatedAccess.staff.displayName} ({ROLE_LABEL[simulatedAccess.staff.role]})
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 font-bold ${
                        simulatedAccess.access.moduleVisible
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-red-100 text-red-900"
                      }`}
                    >
                      {simulatedAccess.access.moduleVisible ? "الوحدة ظاهرة" : "الوحدة مخفية بالكامل"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ORTHO_PERMISSIONS.filter((p) => simulatedAccess.access.permissions[p]).map((p) => (
                      <span key={p} className="rounded bg-white border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                        {ORTHO_PERMISSION_META[p].labelAr}
                      </span>
                    ))}
                    {ORTHO_PERMISSIONS.every((p) => !simulatedAccess.access.permissions[p]) && (
                      <span className="text-red-700">لا يملك أي صلاحية داخل وحدة التقويم.</span>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
