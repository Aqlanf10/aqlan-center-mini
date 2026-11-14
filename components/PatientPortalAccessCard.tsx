"use client";

import { useCallback, useEffect, useState } from "react";

interface AccountSummary {
  exists: boolean;
  patientId: number;
  loginName: string | null;
  status: "not_activated" | "pending_activation" | "active" | "disabled";
  activatedAt: string | null;
  lastLoginAt: string | null;
  disabledReason: string | null;
  hasPendingToken: boolean;
  pendingTokenPurpose: "activate" | "reset" | "in_person_reset" | null;
  pendingTokenExpiresAt: string | null;
  hasSharedFamilyPhone?: boolean;
  sharedPhonePatientsCount?: number;
}

interface StaffPortalPermissions {
  isOwner: boolean;
  canManagePortal: boolean;
  canPreviewPortal: boolean;
}

const STATUS_BADGE: Record<AccountSummary["status"], { label: string; cls: string }> = {
  not_activated: { label: "غير مفعّل", cls: "bg-slate-100 text-slate-700 border-slate-200" },
  pending_activation: {
    label: "بانتظار تعيين كلمة المرور",
    cls: "bg-amber-50 text-amber-800 border-amber-200",
  },
  active: { label: "مفعّل ونشط", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  disabled: { label: "معطّل", cls: "bg-rose-50 text-rose-800 border-rose-200" },
};

export function PatientPortalAccessCard({
  patientId,
  patientNumber,
  patientPhone,
}: {
  patientId: number;
  patientNumber: string;
  patientPhone: string | null;
}) {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [activationEnabled, setActivationEnabled] = useState(false);
  const [permissions, setPermissions] = useState<StaffPortalPermissions>({
    isOwner: false,
    canManagePortal: false,
    canPreviewPortal: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [oneTimeUrl, setOneTimeUrl] = useState<string | null>(null);

  const [loginName, setLoginName] = useState("");
  const [channel, setChannel] = useState<"whatsapp" | "sms" | "in_person">("whatsapp");
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [updatedPhone, setUpdatedPhone] = useState("");
  const [inPersonDelivery, setInPersonDelivery] = useState<"in_person" | "whatsapp" | "sms">("in_person");
  const [verificationNote, setVerificationNote] = useState("");

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewReason, setPreviewReason] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/portal-account`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      setAccount(data.account);
      setActivationEnabled(Boolean(data.policyConfig?.activationEnabled));
      setPermissions(data.permissions);
      if (data.account?.loginName) {
        setLoginName(data.account.loginName);
      } else {
        setLoginName(
          patientNumber
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, "-") || `patient.${patientId}`,
        );
      }
    } catch {
      // ignore transient network errors on card load
    } finally {
      setLoading(false);
    }
  }, [patientId, patientNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setOneTimeUrl(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/portal-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر تنفيذ العملية.");
      }
      if (payload?.account) setAccount(payload.account);
      setNotice(payload?.message ?? "تمت العملية بنجاح.");
      if (typeof payload?.inPersonUrl === "string") {
        setOneTimeUrl(payload.inPersonUrl);
      }
      setVerificationNote("");
      setVerifiedPhone("");
      setUpdatedPhone("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تنفيذ العملية.");
    } finally {
      setBusy(false);
    }
  };

  const startAdminPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/portal-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: previewReason }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر بدء العرض الإداري.");
      }
      window.location.assign(payload?.redirectUrl ?? "/portal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر بدء العرض الإداري.");
    } finally {
      setBusy(false);
    }
  };

  if (loading || !account) return null;
  if (!permissions.canManagePortal && !permissions.canPreviewPortal) return null;

  const badge = STATUS_BADGE[account.status];

  return (
    <section
      aria-label="إدارة وأمان بوابة المريض"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-black text-navy-900">بوابة المريض والأمان</h3>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${badge.cls}`}>
            {badge.label}
          </span>
          {account.loginName && (
            <span dir="ltr" className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
              {account.loginName}
            </span>
          )}
        </div>

        {permissions.canPreviewPortal && (
          <button
            type="button"
            data-testid="admin-portal-preview-btn"
            onClick={() => setShowPreviewModal((v) => !v)}
            className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-900 hover:bg-amber-100"
          >
            عرض بوابة المريض
          </button>
        )}
      </div>

      {showPreviewModal && permissions.canPreviewPortal && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50/70 p-3 space-y-2">
          <p className="text-xs font-bold text-amber-950">
            دخول إداري للقراءة فقط باسمك وصلاحياتك — يُسجَّل اسم الموظف والوقت والسبب في سجل التدقيق.
          </p>
          <input
            type="text"
            value={previewReason}
            onChange={(e) => setPreviewReason(e.target.value)}
            placeholder="اكتب سبب عرض البوابة (مثال: مراجعة مطابقة كشف الحساب مع المريض)…"
            className="w-full rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || previewReason.trim().length < 5}
              onClick={() => void startAdminPreview()}
              className="rounded-xl bg-amber-900 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50"
            >
              {busy ? "جارٍ الفتح…" : "بدء العرض الإداري المقيّد"}
            </button>
            <button
              type="button"
              onClick={() => setShowPreviewModal(false)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      {!activationEnabled && (
        <p
          data-testid="patient-portal-card-disabled-banner"
          className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs font-bold text-amber-950"
        >
          تفعيل الحسابات الجديدة وإصدار روابط التفعيل والاستعادة معطّل افتراضيًا حتى اعتماد سياسات التشغيل النهائية من المالك (يبقى التعطيل الطارئ وإبطال الجلسات متاحًا).
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-xl border border-danger-200 bg-danger-50 p-2.5 text-xs font-bold text-danger-800">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-xs font-bold text-emerald-900">
          {notice}
        </p>
      )}
      {oneTimeUrl && (
        <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-950 space-y-1.5">
          <p className="font-black">
            رابط التحقق الحضوري أحادي الاستخدام (يُعرض الآن فقط ولا يُحفظ في السجلات):
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              dir="ltr"
              value={oneTimeUrl}
              className="flex-1 rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(oneTimeUrl);
              }}
              className="rounded-lg bg-navy-800 px-2.5 py-1.5 text-[11px] font-bold text-white"
            >
              نسخ
            </button>
          </div>
        </div>
      )}

      {permissions.canManagePortal && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          {account.hasSharedFamilyPhone && (
            <p className="rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs font-bold text-amber-950">
              تنبيه هاتف عائلي مشترك ({account.sharedPhonePatientsCount ?? 2} ملفات تشترك في هذا الرقم): لا تعتمد على الهاتف وحده؛ تحقّق من اسم المريض ورقم ملفه ({patientNumber}) وهويته قبل التفعيل أو الاستعادة، ووثّق التحقق في الملاحظة (8 أحرف على الأقل).
            </p>
          )}
          {(account.status === "not_activated" || account.status === "pending_activation") && (
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-xs">
                <span className="mb-1 block font-bold text-slate-600">اسم المستخدم للمريض</span>
                <input
                  type="text"
                  dir="ltr"
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 font-mono text-xs"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-bold text-slate-600">وسيلة إرسال رابط التفعيل</span>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as "whatsapp" | "sms" | "in_person")}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                >
                  <option value="whatsapp">واتساب ({patientPhone ?? "بلا رقم"})</option>
                  <option value="sms">رسالة نصية SMS ({patientPhone ?? "بلا رقم"})</option>
                  <option value="in_person">تسليم حضوري مباشر في الاستقبال</option>
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-bold text-slate-600">ملاحظة التحقق</span>
                <input
                  type="text"
                  value={verificationNote}
                  onChange={(e) => setVerificationNote(e.target.value)}
                  placeholder={
                    channel === "in_person" ? "إلزامي: وثّق التحقق من الهوية حضوريًا" : "ملاحظة اختيارية"
                  }
                  className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs"
                />
              </label>
              <div className="sm:col-span-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction({
                      action: "activate",
                      loginName,
                      deliveryChannel: channel,
                      verificationNote,
                    })
                  }
                  className="rounded-xl bg-navy-800 px-3.5 py-2 text-xs font-black text-white disabled:opacity-50"
                >
                  {account.status === "pending_activation"
                    ? "إعادة إصدار رابط التفعيل المؤقت"
                    : "تفعيل حساب البوابة وإرسال الرابط"}
                </button>
              </div>
            </div>
          )}

          {account.status === "active" && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-700">
                استعادة كلمة المرور (بعد تحقق الموظف من هوية المريض ورقمه أو التحقق الحضوري وتحديث وسيلة التواصل):
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs">
                  <span className="mb-1 block font-bold text-slate-600">مسار الاستعادة</span>
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as "whatsapp" | "sms" | "in_person")}
                    className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <option value="whatsapp">واتساب للرقم المسجّل</option>
                    <option value="sms">SMS للرقم المسجّل</option>
                    <option value="in_person">تحقق حضوري وتحديث وسيلة التواصل</option>
                  </select>
                </label>
                {channel !== "in_person" ? (
                  <label className="text-xs">
                    <span className="mb-1 block font-bold text-slate-600">تأكيد رقم هاتف المريض المسجّل</span>
                    <input
                      type="tel"
                      dir="ltr"
                      value={verifiedPhone}
                      onChange={(e) => setVerifiedPhone(e.target.value)}
                      placeholder={patientPhone ?? "777..."}
                      className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs"
                    />
                  </label>
                ) : (
                  <>
                    <label className="text-xs">
                      <span className="mb-1 block font-bold text-slate-600">تحديث رقم الهاتف (عند فقدان القديم)</span>
                      <input
                        type="tel"
                        dir="ltr"
                        value={updatedPhone}
                        onChange={(e) => setUpdatedPhone(e.target.value)}
                        placeholder={patientPhone ? `الحالي: ${patientPhone}` : "أدخل الرقم الجديد…"}
                        className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs"
                      />
                    </label>
                    <label className="text-xs">
                      <span className="mb-1 block font-bold text-slate-600">تسليم الرابط المؤقت بعد التحقق</span>
                      <select
                        value={inPersonDelivery}
                        onChange={(e) => setInPersonDelivery(e.target.value as "in_person" | "whatsapp" | "sms")}
                        className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                      >
                        <option value="in_person">عرض رابط مؤقت أحادي الاستخدام الآن (15 د)</option>
                        <option value="whatsapp">إرسال عبر واتساب للرقم المحدّث/المسجّل (30 د)</option>
                        <option value="sms">إرسال عبر SMS للرقم المحدّث/المسجّل (30 د)</option>
                      </select>
                    </label>
                  </>
                )}
                <label className={channel === "in_person" ? "text-xs sm:col-span-3" : "text-xs"}>
                  <span className="mb-1 block font-bold text-slate-600">توثيق التحقق من الهوية</span>
                  <input
                    type="text"
                    value={verificationNote}
                    onChange={(e) => setVerificationNote(e.target.value)}
                    placeholder="مثال: حضور المريض شخصيًا ومطابقة البطاقة الشخصية وتحديث الرقم"
                    className="w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      channel === "in_person"
                        ? {
                            action: "in_person_reset",
                            deliveryChannel: inPersonDelivery,
                            updatedPhone: updatedPhone.trim() || undefined,
                            verificationNote,
                          }
                        : {
                            action: "send_reset",
                            deliveryChannel: channel,
                            verifiedPhone,
                            verificationNote,
                          },
                    )
                  }
                  className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50"
                >
                  إصدار رابط إعادة تعيين مؤقت أحادي الاستخدام
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction({ action: "revoke_sessions" })}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                >
                  إبطال الجلسات الحالية
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction({ action: "disable", reason: "تعطيل إداري من ملف المريض" })
                  }
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-800"
                >
                  تعطيل الحساب
                </button>
              </div>
            </div>
          )}

          {account.status === "disabled" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction({ action: "enable" })}
              className="rounded-xl bg-emerald-700 px-3.5 py-1.5 text-xs font-black text-white disabled:opacity-50"
            >
              إعادة تمكين حساب البوابة
            </button>
          )}
        </div>
      )}
    </section>
  );
}
