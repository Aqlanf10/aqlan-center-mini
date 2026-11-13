"use client";

import { useCallback, useEffect, useState } from "react";

interface GrantRow {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canManagePortal: boolean;
  canPreviewPortal: boolean;
  note: string | null;
}

interface ReadinessSummary {
  totalPatients: number;
  portalAccountsTotal: number;
  activeAccounts: number;
  pendingAccounts: number;
  disabledAccounts: number;
  legacyLoginsLast7Days: number;
}

export default function PatientPortalSecuritySettingsPage() {
  const [me, setMe] = useState<{ isOwner: boolean; canManagePortal: boolean; role?: string } | null>(null);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/patient-portal", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? "تعذّر تحميل إعدادات أمان بوابة المريض.");
      }
      setMe(payload.me);
      setGrants(payload.grants);
      setReadiness(payload.readiness);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحميل.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleGrant = async (row: GrantRow, patch: Partial<Pick<GrantRow, "canManagePortal" | "canPreviewPortal">>) => {
    setSavingId(row.userId);
    setError(null);
    try {
      const response = await fetch("/api/settings/patient-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: row.userId,
          canManagePortal: patch.canManagePortal ?? row.canManagePortal,
          canPreviewPortal: patch.canPreviewPortal ?? row.canPreviewPortal,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحديث الصلاحيات.");
      setGrants(payload.grants);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحديث.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 pb-16">
      <header>
        <h1 className="text-xl font-black text-navy-900">أمان وصلاحيات بوابة المريض</h1>
        <p className="mt-1 text-sm text-slate-600">
          إدارة الموظفين المخوّلين بتفعيل حسابات البوابة واستعادة كلمات المرور، وصلاحية «عرض بوابة
          المريض» المستقلة المحصورة بالمالك والإدارة المخوّلة فقط.
        </p>
      </header>

      {error && (
        <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
          {error}
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
            <p className="text-xs text-slate-500">الدخول القديم بالهاتف</p>
            <p className="mt-1 text-sm font-black text-emerald-800">محذوف نهائيًا ✓</p>
          </div>
        </section>
      )}

      <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-right text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="p-3">الموظف</th>
              <th className="p-3">الدور</th>
              <th className="p-3">تفعيل الحسابات واستعادة كلمة المرور</th>
              <th className="p-3">زر «عرض بوابة المريض» (للإدارة فقط)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {grants.map((row) => (
              <tr key={row.userId} className={!row.isActive ? "opacity-50" : ""}>
                <td className="p-3">
                  <div className="font-bold text-navy-900">
                    {row.displayName}{" "}
                    {row.isOwner && (
                      <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-900">
                        المالك
                      </span>
                    )}
                  </div>
                  <div dir="ltr" className="font-mono text-xs text-slate-500">
                    {row.username}
                  </div>
                </td>
                <td className="p-3 text-xs font-bold text-slate-700">{row.role}</td>
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={row.canManagePortal}
                    disabled={
                      savingId === row.userId ||
                      row.isOwner ||
                      (!me?.isOwner && me?.role !== "admin")
                    }
                    onChange={(e) => void toggleGrant(row, { canManagePortal: e.target.checked })}
                  />
                </td>
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={row.canPreviewPortal}
                    disabled={
                      savingId === row.userId ||
                      row.isOwner ||
                      row.role !== "admin" ||
                      !me?.isOwner
                    }
                    onChange={(e) => void toggleGrant(row, { canPreviewPortal: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
