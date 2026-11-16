"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Eye,
  Lock,
  Megaphone,
  Plus,
  Save,
  Search,
  Shield,
  Sliders,
  Trash2,
  Users,
} from "lucide-react";

type PortalOperatingMode = "disabled" | "sandbox_test" | "live_enabled";
type PortalRecoveryPhonePolicy =
  | "disallow_inline"
  | "owner_only"
  | "admin_or_owner_only"
  | "portal_manager_in_person";
type PortalPostMergeTargetPolicy =
  | "suspend_target"
  | "suspend_on_conflict_or_dual"
  | "keep_target_revoke_sessions";
type AnnouncementTone = "sky" | "navy" | "accent" | "emerald" | "amber";

interface StaffAccessMe {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canConfigurePortalSettings: boolean;
  canManagePortal: boolean;
  canIssueActivation: boolean;
  canIssueReset: boolean;
  canChangeRecoveryPhone: boolean;
  canPreviewPortal: boolean;
  canManagePortalAnnouncements: boolean;
  canInspectRetainedMessages: boolean;
}

interface GrantRow extends StaffAccessMe {
  note: string | null;
  updatedAt: string | null;
}

interface ReadinessSummary {
  totalPatients: number;
  portalAccountsTotal: number;
  activeAccounts: number;
  pendingAccounts: number;
  disabledAccounts: number;
  legacyLoginsLast7Days: number;
}

interface PortalSettingsData {
  operatingMode: PortalOperatingMode;
  effectiveOperatingMode: PortalOperatingMode;
  productionLaunchLocked: boolean;
  allowWhatsappChannel: boolean;
  allowSmsChannel: boolean;
  allowInPersonChannel: boolean;
  recoveryPhonePolicy: PortalRecoveryPhonePolicy;
  postMergeTargetPolicy: PortalPostMergeTargetPolicy;
  activationTtlMinutes: number;
  resetTtlMinutes: number;
  inPersonResetTtlMinutes: number;
  sessionTtlHours: number;
  adminPreviewTtlMinutes: number;
  maxTokenAttempts: number;
  maxFailedLoginAttempts: number;
  loginFailureWindowMinutes: number;
  accountLockoutMinutes: number;
  showProfile: boolean;
  showAppointments: boolean;
  allowAppointmentConfirm: boolean;
  showBookingLink: boolean;
  showVisits: boolean;
  showTreatmentPlans: boolean;
  showStatement: boolean;
  showPrescriptions: boolean;
  showDocuments: boolean;
  showXrayDocuments: boolean;
  showIntake: boolean;
  showMessages: boolean;
  allowMessageAttachments: boolean;
  allowVoiceMessages: boolean;
  showAnnouncements: boolean;
  deletedMessageRetentionMode: string;
  updatedAt: string | null;
}

interface AnnouncementItem {
  id: number;
  titleAr: string;
  bodyAr: string;
  titleEn: string | null;
  bodyEn: string | null;
  badgeLabel: string | null;
  tone: AnnouncementTone;
  sortOrder: number;
  isActive: boolean;
  isSample: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

interface RetainedMessageRecord {
  id: number;
  patientId: number;
  senderType: string;
  senderName: string | null;
  kind: string;
  body: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  voiceMs: number | null;
  createdAt: string;
  deletedAt: string | null;
  deletedByActor: string | null;
}

const TONE_LABELS: Record<AnnouncementTone, string> = {
  sky: "سماوي هادئ (هوية المركز)",
  navy: "كحلي رسمي",
  accent: "برتقالي بارز",
  emerald: "أخضر مطمئن",
  amber: "كهرماني تنبيهي",
};

export default function PatientPortalSecuritySettingsPage() {
  const [me, setMe] = useState<StaffAccessMe | null>(null);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);
  const [settings, setSettings] = useState<PortalSettingsData | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingGrantId, setSavingGrantId] = useState<number | null>(null);

  // نموذج إضافة / تعديل إعلان المركز
  const [editingAnnId, setEditingAnnId] = useState<number | null>(null);
  const [annTitleAr, setAnnTitleAr] = useState("");
  const [annBodyAr, setAnnBodyAr] = useState("");
  const [annTitleEn, setAnnTitleEn] = useState("");
  const [annBodyEn, setAnnBodyEn] = useState("");
  const [annBadge, setAnnBadge] = useState("");
  const [annTone, setAnnTone] = useState<AnnouncementTone>("sky");
  const [annActive, setAnnActive] = useState(true);
  const [annSample, setAnnSample] = useState(false);
  const [annStartsAt, setAnnStartsAt] = useState("");
  const [annEndsAt, setAnnEndsAt] = useState("");
  const [savingAnn, setSavingAnn] = useState(false);

  // معاينة عهدة الرسائل المحذوفة
  const [inspectMessageId, setInspectMessageId] = useState("");
  const [inspectReason, setInspectReason] = useState("");
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectedRecord, setInspectedRecord] = useState<RetainedMessageRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/patient-portal", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر تحميل إعدادات وسياسات بوابة المريض.");
      }
      setMe(payload.me);
      setGrants(payload.grants ?? []);
      setReadiness(payload.readiness ?? null);
      setSettings(payload.settings ?? null);
      setAnnouncements(payload.announcements ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canEditSettings = Boolean(me?.isOwner || me?.canConfigurePortalSettings);
  const canEditAnnouncements = Boolean(me?.isOwner || me?.canManagePortalAnnouncements);

  const saveSettings = async () => {
    if (!settings || !canEditSettings) return;
    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/patient-portal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر حفظ إعدادات البوابة.");
      }
      setSettings(payload.settings);
      setNotice("تم حفظ إعدادات وسياسات بوابة المريض وتوثيق التعديل في سجل التدقيق.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر حفظ الإعدادات.");
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleGrant = async (
    row: GrantRow,
    patch: Partial<{
      canConfigurePortalSettings: boolean;
      canManagePortal: boolean;
      canIssueActivation: boolean | null;
      canIssueReset: boolean | null;
      canChangeRecoveryPhone: boolean | null;
      canPreviewPortal: boolean;
      canManagePortalAnnouncements: boolean;
    }>,
  ) => {
    setSavingGrantId(row.userId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/patient-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: row.userId,
          canConfigurePortalSettings:
            patch.canConfigurePortalSettings ?? row.canConfigurePortalSettings,
          canManagePortal: patch.canManagePortal ?? row.canManagePortal,
          canIssueActivation:
            patch.canIssueActivation !== undefined
              ? patch.canIssueActivation
              : row.canIssueActivation,
          canIssueReset:
            patch.canIssueReset !== undefined ? patch.canIssueReset : row.canIssueReset,
          canChangeRecoveryPhone:
            patch.canChangeRecoveryPhone !== undefined
              ? patch.canChangeRecoveryPhone
              : row.canChangeRecoveryPhone,
          canPreviewPortal: patch.canPreviewPortal ?? row.canPreviewPortal,
          canManagePortalAnnouncements:
            patch.canManagePortalAnnouncements ?? row.canManagePortalAnnouncements,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحديث الصلاحيات.");
      setGrants(payload.grants ?? []);
      setNotice(`تم تحديث صلاحيات الموظف (${row.displayName}) بنجاح.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحديث الصلاحيات.");
    } finally {
      setSavingGrantId(null);
    }
  };

  const resetAnnouncementForm = () => {
    setEditingAnnId(null);
    setAnnTitleAr("");
    setAnnBodyAr("");
    setAnnTitleEn("");
    setAnnBodyEn("");
    setAnnBadge("");
    setAnnTone("sky");
    setAnnActive(true);
    setAnnSample(false);
    setAnnStartsAt("");
    setAnnEndsAt("");
  };

  const startEditAnnouncement = (item: AnnouncementItem) => {
    setEditingAnnId(item.id);
    setAnnTitleAr(item.titleAr);
    setAnnBodyAr(item.bodyAr);
    setAnnTitleEn(item.titleEn ?? "");
    setAnnBodyEn(item.bodyEn ?? "");
    setAnnBadge(item.badgeLabel ?? "");
    setAnnTone(item.tone);
    setAnnActive(item.isActive);
    setAnnSample(item.isSample);
    setAnnStartsAt(item.startsAt ? item.startsAt.slice(0, 16) : "");
    setAnnEndsAt(item.endsAt ? item.endsAt.slice(0, 16) : "");
  };

  const saveAnnouncement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canEditAnnouncements) return;
    setSavingAnn(true);
    setError(null);
    setNotice(null);
    try {
      const method = editingAnnId ? "PATCH" : "POST";
      const bodyPayload = {
        ...(editingAnnId ? { id: editingAnnId } : {}),
        titleAr: annTitleAr,
        bodyAr: annBodyAr,
        titleEn: annTitleEn.trim() || null,
        bodyEn: annBodyEn.trim() || null,
        badgeLabel: annBadge.trim() || null,
        tone: annTone,
        isActive: annActive,
        isSample: annSample,
        startsAt: annStartsAt ? new Date(annStartsAt).toISOString() : null,
        endsAt: annEndsAt ? new Date(annEndsAt).toISOString() : null,
      };
      const response = await fetch("/api/settings/patient-portal/announcements", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر حفظ الإعلان.");
      setAnnouncements(payload.announcements ?? []);
      resetAnnouncementForm();
      setNotice(editingAnnId ? "تم تحديث إعلان المركز." : "أُضيف إعلان المركز بنجاح.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر حفظ الإعلان.");
    } finally {
      setSavingAnn(false);
    }
  };

  const toggleAnnouncementActive = async (item: AnnouncementItem) => {
    setSavingAnn(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/patient-portal/announcements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, isActive: !item.isActive }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحديث حالة الإعلان.");
      setAnnouncements(payload.announcements ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحديث.");
    } finally {
      setSavingAnn(false);
    }
  };

  const moveAnnouncement = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= announcements.length) return;
    const next = [...announcements];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    const orderedIds = next.map((a) => a.id);
    setSavingAnn(true);
    try {
      const response = await fetch("/api/settings/patient-portal/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reorder", orderedIds }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر إعادة الترتيب.");
      setAnnouncements(payload.announcements ?? next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إعادة الترتيب.");
    } finally {
      setSavingAnn(false);
    }
  };

  const removeAnnouncement = async (id: number) => {
    if (!window.confirm("حذف هذا الإعلان نهائيًا من قائمة إعلانات البوابة؟")) return;
    setSavingAnn(true);
    try {
      const response = await fetch(`/api/settings/patient-portal/announcements?id=${id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر حذف الإعلان.");
      setAnnouncements(payload.announcements ?? []);
      if (editingAnnId === id) resetAnnouncementForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر الحذف.");
    } finally {
      setSavingAnn(false);
    }
  };

  const inspectRetainedMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    setInspectBusy(true);
    setError(null);
    setInspectedRecord(null);
    try {
      const response = await fetch("/api/settings/patient-portal/retained-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: Number(inspectMessageId),
          reason: inspectReason,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر معاينة السجل المحذوف.");
      }
      setInspectedRecord(payload.record ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر المعاينة.");
    } finally {
      setInspectBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl p-6 text-sm font-bold text-slate-500">
        جارٍ تحميل مركز التحكم ببوابة المريض…
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 pb-20">
      <header className="rounded-2xl border border-sky-200 bg-gradient-to-l from-white via-sky-50/40 to-slate-50 p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black text-sky-700">
              مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان
            </p>
            <h1 className="mt-1 text-xl font-black text-navy-900">
              إعدادات وسياسات وأمان بوابة المريض
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              تحكّم كامل للمالك والمدير المفوّض في وضع التشغيل، والأقسام المعروضة للمريض، ومدد
              الروابط والجلسات، ومصفوفة صلاحيات الموظفين، وإعلانات شاشة الدخول — دون تثبيت في الكود.
            </p>
          </div>
          {me && (
            <span
              className={`rounded-full border px-3 py-1 text-xs font-black ${
                me.isOwner
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : canEditSettings
                    ? "border-sky-300 bg-sky-50 text-sky-950"
                    : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              {me.isOwner
                ? "صلاحية المالك المعتمد الكاملة"
                : canEditSettings
                  ? "مدير مفوّض بضبط الإعدادات"
                  : "اطلاع إداري (التعديل مفصول بصلاحية مستقلة)"}
            </span>
          )}
        </div>
      </header>

      {settings && settings.effectiveOperatingMode === "disabled" && (
        <section
          data-testid="portal-activation-disabled-banner"
          className="space-y-1.5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950"
        >
          <p className="flex items-center gap-2 text-sm font-black">
            <Lock className="h-4 w-4 text-amber-800" />
            بوابة المريض في وضع التعطيل الآمن افتراضيًا (Fail-Closed) — لم تُفتح للمرضى الفعليين
          </p>
          <p>
            لتجربة البوابة في بيئة اختبار معزولة وبيانات اصطناعية دون إرسال أي رسائل واتساب أو SMS
            خارجية، يمكن للمالك أو المدير المفوّض اختيار وضع{" "}
            <strong>«وضع الاختبار المعزول (Sandbox)»</strong> أدناه. يبقى الإطلاق الفعلي مقفلًا حتى
            يقرر المالك الإطلاق الرسمي.
          </p>
        </section>
      )}

      {settings && settings.effectiveOperatingMode === "sandbox_test" && (
        <section
          data-testid="portal-sandbox-active-banner"
          className="space-y-1 rounded-2xl border border-sky-300 bg-sky-50 p-4 text-xs text-sky-950"
        >
          <p className="flex items-center gap-2 text-sm font-black">
            <Shield className="h-4 w-4 text-sky-700" />
            وضع الاختبار المعزول بالبيانات الاصطناعية نشط (Sandbox Test Mode)
          </p>
          <p>
            جميع وظائف البوابة عاملة للفحص المحلي والاستيجنج، مع حظر تلقائي تام لإرسال أي رسائل
            واتساب أو SMS خارجية وعرض روابط المحاكاة داخل بطاقة المريض فقط.
          </p>
        </section>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-900"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {notice}
        </p>
      )}

      {readiness && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
            <p className="text-xs text-slate-500">حسابات البوابة النشطة</p>
            <p className="mt-1 text-lg font-black text-navy-900">{readiness.activeAccounts}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
            <p className="text-xs text-slate-500">بانتظار التفعيل</p>
            <p className="mt-1 text-lg font-black text-amber-800">{readiness.pendingAccounts}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
            <p className="text-xs text-slate-500">حسابات معطّلة</p>
            <p className="mt-1 text-lg font-black text-rose-800">{readiness.disabledAccounts}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
            <p className="text-xs text-slate-500">الدخول بالهاتف فقط</p>
            <p className="mt-1 text-sm font-black text-emerald-800">ملغى نهائيًا ✓</p>
          </div>
        </section>
      )}

      {/* القسم 1 + 2 + 3: إعدادات وضع التشغيل والأقسام والسياسات الأمنية */}
      {settings && (
        <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Sliders className="h-5 w-5 text-sky-600" />
              <h2 className="text-base font-black text-navy-900">
                1. وضع التشغيل، الأقسام المتاحة للمريض، والسياسات الأمنية
              </h2>
            </div>
            <button
              type="button"
              data-testid="save-portal-settings-btn"
              disabled={!canEditSettings || savingSettings}
              onClick={() => void saveSettings()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white hover:bg-navy-900 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {savingSettings ? "جارٍ الحفظ…" : "حفظ إعدادات وسياسات البوابة"}
            </button>
          </div>

          {!canEditSettings && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-950">
              صلاحية تعديل إعدادات وسياسات البوابة مفصولة عن صلاحيات التشغيل، وتُمنح بتفويض صريح من
              مالك المركز فقط.
            </p>
          )}

          {/* وضع التشغيل وقنوات التسليم */}
          <div className="grid gap-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4 sm:grid-cols-2">
            <label className="block text-xs sm:col-span-2">
              <span className="mb-1.5 block font-black text-navy-900">
                وضع تشغيل بوابة المريض
              </span>
              <select
                data-testid="portal-operating-mode-select"
                disabled={!canEditSettings}
                value={settings.operatingMode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    operatingMode: e.target.value as PortalOperatingMode,
                  })
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-900 disabled:bg-slate-100"
              >
                <option value="disabled">
                  معطّل (Fail-Closed) — التفعيل وإصدار الروابط موقوف
                </option>
                <option value="sandbox_test">
                  وضع الاختبار المعزول (Sandbox) — كامل الوظائف ببيانات اصطناعية ودون رسائل خارجية
                </option>
                <option
                  value="live_enabled"
                  disabled={!me?.isOwner || settings.productionLaunchLocked}
                >
                  التشغيل الفعلي للمرضى (للمالك فقط بعد قرار الإطلاق الرسمي
                  {settings.productionLaunchLocked ? " — مقفَل في الإنتاج حاليًا" : ""})
                </option>
              </select>
            </label>

            <div className="space-y-2 sm:col-span-2">
              <p className="text-xs font-black text-navy-900">قنوات تسليم روابط التفعيل والاستعادة</p>
              <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-700">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!canEditSettings}
                    checked={settings.allowInPersonChannel}
                    onChange={(e) =>
                      setSettings({ ...settings, allowInPersonChannel: e.target.checked })
                    }
                  />
                  تسليم حضوري مباشر في الاستقبال
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!canEditSettings}
                    checked={settings.allowWhatsappChannel}
                    onChange={(e) =>
                      setSettings({ ...settings, allowWhatsappChannel: e.target.checked })
                    }
                  />
                  واتساب (يُحاكى محليًا في وضع الاختبار المعزول)
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!canEditSettings}
                    checked={settings.allowSmsChannel}
                    onChange={(e) =>
                      setSettings({ ...settings, allowSmsChannel: e.target.checked })
                    }
                  />
                  رسائل نصية SMS (تُحاكى محليًا في وضع الاختبار المعزول)
                </label>
              </div>
            </div>
          </div>

          {/* مفاتيح إظهار الأقسام للمريض */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-black text-navy-900">
              الأقسام والمزايا المسموح بعرضها للمريض داخل البوابة (تُطبَّق على الواجهة والـ API معًا)
            </h3>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 text-xs">
              {(
                [
                  ["showProfile", "ملخص بيانات المريض الأساسية (بهاتف مقنّع)"],
                  ["showAppointments", "المواعيد القادمة وسجل المواعيد السابقة"],
                  ["allowAppointmentConfirm", "السماح للمريض بتأكيد حضور الموعد"],
                  ["showBookingLink", "رابط طلب حجز موعد جديد (/book)"],
                  ["showVisits", "ملخص الزيارات السريرية الموقّعة فقط"],
                  ["showTreatmentPlans", "خطط العلاج المعتمدة ونسبة الإنجاز"],
                  ["showPrescriptions", "الروشتات الطبية الفعّالة الصادرة"],
                  ["showStatement", "الفواتير والدفعات وكشف الحساب المالي"],
                  ["showDocuments", "التقارير والمستندات المسموح بتنزيلها"],
                  ["showXrayDocuments", "تضمين صور الأشعة والصور السريرية (افتراضيًا معطّل)"],
                  ["showIntake", "الاستمارة الصحية الأولية وتحديثها"],
                  ["showMessages", "محادثة العيادة والرسائل"],
                  ["allowMessageAttachments", "السماح برفع صور ومرفقات PDF في المحادثة"],
                  ["allowVoiceMessages", "السماح بإرسال رسائل صوتية في المحادثة"],
                  ["showAnnouncements", "عرض إعلانات وأخبار المركز في شاشة الدخول"],
                ] as const
              ).map(([field, label]) => (
                <label
                  key={field}
                  className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 font-bold text-slate-700"
                >
                  <input
                    type="checkbox"
                    disabled={!canEditSettings}
                    checked={Boolean(settings[field])}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [field]: e.target.checked,
                      })
                    }
                    className="mt-0.5"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* سياسات الهاتف المفقود، دمج الملفات، ومدد الصلاحية والقفل */}
          <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1 block font-black text-navy-900">
                سياسة تغيير رقم الهاتف عند استعادة الحساب (التحقق الحضوري)
              </span>
              <select
                disabled={!canEditSettings}
                value={settings.recoveryPhonePolicy}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    recoveryPhonePolicy: e.target.value as PortalRecoveryPhonePolicy,
                  })
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
              >
                <option value="disallow_inline">
                  منع التغيير المباشر أثناء الاستعادة (يُحدَّث الهاتف من ملف المريض أولًا)
                </option>
                <option value="owner_only">المالك المعتمد فقط بعد التحقق الحضوري</option>
                <option value="admin_or_owner_only">المالك أو الإدارة المخوّلة حضوريًا</option>
                <option value="portal_manager_in_person">
                  الموظف المخوّل بالتحقق الحضوري وتغيير وسيلة التواصل
                </option>
              </select>
            </label>

            <label className="block text-xs">
              <span className="mb-1 block font-black text-navy-900">
                سياسة حساب البوابة بعد دمج ملفي مريض مكرّرين
              </span>
              <select
                disabled={!canEditSettings}
                value={settings.postMergeTargetPolicy}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    postMergeTargetPolicy: e.target.value as PortalPostMergeTargetPolicy,
                  })
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
              >
                <option value="suspend_target">
                  تعليق حساب الملف المدموج احترازيًا لحين مراجعة الهوية (الأكثر أمانًا)
                </option>
                <option value="suspend_on_conflict_or_dual">
                  التعليق فقط عند وجود حسابين نشطين أو تعارض هاتف
                </option>
                <option value="keep_target_revoke_sessions">
                  الإبقاء على حساب الهدف نشطًا مع إبطال جميع الجلسات والروابط السابقة
                </option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 text-xs">
            {(
              [
                ["activationTtlMinutes", "صلاحية رابط التفعيل (دقيقة)"],
                ["resetTtlMinutes", "صلاحية رابط الاستعادة (دقيقة)"],
                ["inPersonResetTtlMinutes", "رابط الاستقبال الحضوري (دقيقة)"],
                ["sessionTtlHours", "مدة جلسة المريض (ساعة)"],
                ["adminPreviewTtlMinutes", "مدة العرض الإداري (دقيقة)"],
                ["maxTokenAttempts", "حد محاولات الرابط المؤقت"],
                ["maxFailedLoginAttempts", "محاولات الدخول قبل القفل"],
                ["loginFailureWindowMinutes", "نافذة رصد الفشل (دقيقة)"],
                ["accountLockoutMinutes", "مدة القفل المؤقت (دقيقة)"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="block">
                <span className="mb-1 block font-bold text-slate-600">{label}</span>
                <input
                  type="number"
                  dir="ltr"
                  disabled={!canEditSettings}
                  value={settings[field]}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      [field]: Number(e.target.value),
                    })
                  }
                  className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 font-mono text-xs font-bold"
                />
              </label>
            ))}
          </div>
        </section>
      )}

      {/* القسم 4: مصفوفة صلاحيات الموظفين المفصّلة */}
      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-sky-600" />
          <div>
            <h2 className="text-base font-black text-navy-900">
              2. مصفوفة صلاحيات الموظفين المفصّلة على بوابة المريض
            </h2>
            <p className="text-xs text-slate-500">
              تُفصل صلاحية «ضبط إعدادات البوابة» وصلاحية «عرض بوابة المريض» (للمالك فقط منحهما
              للإدارة) عن صلاحيات التشغيل اليومية للتفعيل والاستعادة وإعلانات المركز.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-right text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 font-black text-slate-700">
              <tr>
                <th className="p-2.5">الموظف</th>
                <th className="p-2.5">الدور</th>
                <th className="p-2.5">ضبط الإعدادات (بأمر المالك)</th>
                <th className="p-2.5">إدارة الحسابات</th>
                <th className="p-2.5">إصدار التفعيل</th>
                <th className="p-2.5">إصدار الاستعادة</th>
                <th className="p-2.5">تحديث الهاتف حضوريًا</th>
                <th className="p-2.5">عرض بوابة المريض</th>
                <th className="p-2.5">إدارة الإعلانات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {grants.map((row) => {
                const rowBusy = savingGrantId === row.userId;
                const canManageRow = Boolean(me?.isOwner || canEditSettings);
                return (
                  <tr key={row.userId} className={!row.isActive ? "opacity-50" : ""}>
                    <td className="p-2.5">
                      <div className="font-bold text-navy-900">
                        {row.displayName}{" "}
                        {row.isOwner && (
                          <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-900">
                            المالك
                          </span>
                        )}
                      </div>
                      <div dir="ltr" className="font-mono text-[11px] text-slate-500">
                        {row.username}
                      </div>
                    </td>
                    <td className="p-2.5 font-bold text-slate-700">{row.role}</td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canConfigurePortalSettings}
                        disabled={rowBusy || row.isOwner || row.role !== "admin" || !me?.isOwner}
                        onChange={(e) =>
                          void toggleGrant(row, {
                            canConfigurePortalSettings: e.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canManagePortal}
                        disabled={rowBusy || row.isOwner || !canManageRow}
                        onChange={(e) =>
                          void toggleGrant(row, { canManagePortal: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canIssueActivation}
                        disabled={rowBusy || row.isOwner || !canManageRow}
                        onChange={(e) =>
                          void toggleGrant(row, { canIssueActivation: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canIssueReset}
                        disabled={rowBusy || row.isOwner || !canManageRow}
                        onChange={(e) =>
                          void toggleGrant(row, { canIssueReset: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canChangeRecoveryPhone}
                        disabled={rowBusy || row.isOwner || !canManageRow}
                        onChange={(e) =>
                          void toggleGrant(row, { canChangeRecoveryPhone: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canPreviewPortal}
                        disabled={rowBusy || row.isOwner || row.role !== "admin" || !me?.isOwner}
                        onChange={(e) =>
                          void toggleGrant(row, { canPreviewPortal: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.canManagePortalAnnouncements}
                        disabled={
                          rowBusy ||
                          row.isOwner ||
                          (row.role !== "admin" && row.role !== "reception") ||
                          !canManageRow
                        }
                        onChange={(e) =>
                          void toggleGrant(row, {
                            canManagePortalAnnouncements: e.target.checked,
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* القسم 5: إدارة إعلانات وأخبار المركز على شاشة البوابة */}
      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-sky-600" />
          <div>
            <h2 className="text-base font-black text-navy-900">
              3. إعلانات وأخبار المركز على شاشة بوابة المريض
            </h2>
            <p className="text-xs text-slate-500">
              إعلانات تعريفية وإرشادية هادئة (مواعيد الدوام، الإجازات، تعليمات التفعيل). العناصر
              الموسومة كـ«نموذج تجريبي» لا تُنشر أبدًا عند الإطلاق الفعلي للمرضى.
            </p>
          </div>
        </div>

        {canEditAnnouncements && (
          <form
            onSubmit={saveAnnouncement}
            className="grid gap-3 rounded-xl border border-sky-200/80 bg-sky-50/30 p-4 text-xs sm:grid-cols-2"
          >
            <label className="block">
              <span className="mb-1 block font-bold text-navy-900">عنوان الإعلان (عربي) *</span>
              <input
                type="text"
                required
                value={annTitleAr}
                onChange={(e) => setAnnTitleAr(e.target.value)}
                placeholder="مثال: أوقات الدوام خلال شهر رمضان المبارك"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold text-slate-700">
                العنوان بالإنجليزية (اختياري)
              </span>
              <input
                type="text"
                dir="ltr"
                value={annTitleEn}
                onChange={(e) => setAnnTitleEn(e.target.value)}
                placeholder="Optional English title"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block font-bold text-navy-900">نص الإعلان (عربي) *</span>
              <textarea
                rows={2}
                required
                value={annBodyAr}
                onChange={(e) => setAnnBodyAr(e.target.value)}
                placeholder="اكتب نص الإعلان بوضوح وهدوء دون ادعاءات طبية غير معتمدة…"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-700">
                النص بالإنجليزية (اختياري)
              </span>
              <textarea
                rows={2}
                dir="ltr"
                value={annBodyEn}
                onChange={(e) => setAnnBodyEn(e.target.value)}
                placeholder="Optional English description…"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold text-slate-700">شارة مختصرة (اختياري)</span>
              <input
                type="text"
                value={annBadge}
                onChange={(e) => setAnnBadge(e.target.value)}
                placeholder="مثال: تنويه دوام / خدمة جديدة"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold text-slate-700">النمط اللوني</span>
              <select
                value={annTone}
                onChange={(e) => setAnnTone(e.target.value as AnnouncementTone)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              >
                {(Object.keys(TONE_LABELS) as AnnouncementTone[]).map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-bold text-slate-700">يبدأ العرض من (اختياري)</span>
              <input
                type="datetime-local"
                dir="ltr"
                value={annStartsAt}
                onChange={(e) => setAnnStartsAt(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold text-slate-700">ينتهي العرض في (اختياري)</span>
              <input
                type="datetime-local"
                dir="ltr"
                value={annEndsAt}
                onChange={(e) => setAnnEndsAt(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
              <label className="inline-flex items-center gap-2 font-bold text-slate-700">
                <input
                  type="checkbox"
                  checked={annActive}
                  onChange={(e) => setAnnActive(e.target.checked)}
                />
                مفعّل للعرض
              </label>
              <label className="inline-flex items-center gap-2 font-bold text-amber-900">
                <input
                  type="checkbox"
                  checked={annSample}
                  onChange={(e) => setAnnSample(e.target.checked)}
                />
                نموذج تجريبي — غير منشور للمرضى الفعليين
              </label>
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <button
                type="submit"
                disabled={savingAnn || !annTitleAr.trim() || !annBodyAr.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2 font-black text-white hover:bg-navy-900 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {editingAnnId ? "حفظ تعديل الإعلان" : "إضافة إعلان جديد"}
              </button>
              {editingAnnId && (
                <button
                  type="button"
                  onClick={resetAnnouncementForm}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-bold text-slate-600"
                >
                  إلغاء التعديل
                </button>
              )}
            </div>
          </form>
        )}

        {announcements.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            لا توجد إعلانات مخصّصة محفوظة بعد (في وضع الاختبار المعزول تظهر بطاقتان تعريفيتان
            موسومتان بـ«نموذج تجريبي — غير منشور»).
          </p>
        ) : (
          <ul className="space-y-2.5">
            {announcements.map((item, idx) => (
              <li
                key={item.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black text-navy-900">{item.titleAr}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                        item.isActive
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {item.isActive ? "مفعّل" : "موقوف"}
                    </span>
                    {item.isSample && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-950">
                        نموذج تجريبي — غير منشور
                      </span>
                    )}
                    {item.badgeLabel && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-900">
                        {item.badgeLabel}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-600">{item.bodyAr}</p>
                </div>

                {canEditAnnouncements && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={savingAnn || idx === 0}
                      onClick={() => void moveAnnouncement(idx, -1)}
                      title="تحريك لأعلى"
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={savingAnn || idx === announcements.length - 1}
                      onClick={() => void moveAnnouncement(idx, 1)}
                      title="تحريك لأسفل"
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={savingAnn}
                      onClick={() => void toggleAnnouncementActive(item)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700"
                    >
                      {item.isActive ? "إيقاف" : "تفعيل"}
                    </button>
                    <button
                      type="button"
                      disabled={savingAnn}
                      onClick={() => startEditAnnouncement(item)}
                      className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 font-bold text-sky-900"
                    >
                      تعديل
                    </button>
                    <button
                      type="button"
                      disabled={savingAnn}
                      onClick={() => void removeAnnouncement(item.id)}
                      title="حذف"
                      className="rounded-lg border border-rose-200 bg-rose-50 p-1.5 text-rose-800"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* القسم 6: عهدة الرسائل المحذوفة غير التدميرية والمعاينة الإدارية المدقّقة */}
      {me?.canInspectRetainedMessages && (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-amber-700" />
            <div>
              <h2 className="text-base font-black text-navy-900">
                4. العهدة الآمنة للرسائل المحذوفة (بدون إتلاف نهائي تلقائي)
              </h2>
              <p className="text-xs text-slate-500">
                الرسائل المحذوفة تختفي فورًا من شاشات المحادثة وتنزيل المرفقات العادي، لكنها تُحفظ
                بأمان دون إتلاف نهائي لحين اعتماد سياسة الاحتفاظ من المالك. كل معاينة تسجّل{" "}
                <code>message.retained.inspect</code> في سجل التدقيق.
              </p>
            </div>
          </div>

          <form onSubmit={inspectRetainedMessage} className="grid gap-2.5 sm:grid-cols-4 text-xs">
            <input
              type="number"
              min={1}
              dir="ltr"
              required
              value={inspectMessageId}
              onChange={(e) => setInspectMessageId(e.target.value)}
              placeholder="رقم الرسالة (ID)"
              className="rounded-xl border border-slate-200 px-3 py-2 font-mono"
            />
            <input
              type="text"
              required
              value={inspectReason}
              onChange={(e) => setInspectReason(e.target.value)}
              placeholder="سبب المراجعة الإدارية (8 أحرف على الأقل)…"
              className="rounded-xl border border-slate-200 px-3 py-2 sm:col-span-2"
            />
            <button
              type="submit"
              disabled={inspectBusy || !inspectMessageId || inspectReason.trim().length < 8}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-900 px-3 py-2 font-black text-white disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {inspectBusy ? "جارٍ الفحص…" : "معاينة مدقّقة"}
            </button>
          </form>

          {inspectedRecord && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5 text-xs space-y-1">
              <p className="font-black text-amber-950">
                رسالة محذوفة محفوظة #{inspectedRecord.id} · ملف المريض #{inspectedRecord.patientId}
              </p>
              <p className="text-slate-700">
                <strong>النوع:</strong> {inspectedRecord.kind} · <strong>الحذف بواسطة:</strong>{" "}
                {inspectedRecord.deletedByActor ?? "—"} · <strong>وقت الحذف:</strong>{" "}
                {inspectedRecord.deletedAt ?? "—"}
              </p>
              {inspectedRecord.body && (
                <p className="rounded-lg bg-white p-2 text-slate-800">{inspectedRecord.body}</p>
              )}
              {inspectedRecord.fileName && (
                <p className="text-slate-600">
                  مرفق محتفظ به في العهدة: {inspectedRecord.fileName} ({inspectedRecord.fileMime})
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <footer className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <p>
          <strong>ضمان عدم النشر المبكر:</strong> لا تُرسل أي روابط أو رسائل للمرضى الفعليين في وضع
          التعطيل أو وضع الاختبار المعزول، ويبقى وضع الإطلاق الفعلي مقفلًا في بيئة الإنتاج حتى يكتمل
          تطبيق المرضى الخاص ويصدر قرار المالك الرسمي بالإطلاق.
        </p>
      </footer>
    </main>
  );
}
