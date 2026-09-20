"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";

interface BackupRecord {
  backupId: string;
  createdAt: string;
  triggerType: "manual" | "scheduled";
  archiveSha256: string;
  archiveBytes: number;
  documentCount: number;
  replicationStatus: string;
  deletionProtection: "only-verified" | "latest-verified" | "external-anchor" | "not-found" | null;
}

interface RestoreDrillSummary {
  backupId: string;
  requestedAt: string;
  completedAt: string | null;
  status: "running" | "ready" | "failed";
  targetEnvironment: "staging" | "test";
  archiveSha256: string;
  documentsVerified: number;
  tablesCount: number;
  durationMs: number | null;
  readyForCutover: boolean;
  errorCode: string | null;
}

interface BackupPayload {
  history: BackupRecord[];
  storage: {
    verifiedCount: number;
    totalArchiveBytes: number;
  };
  restore: {
    available: boolean;
    targetEnvironment: "staging" | "test" | null;
    reason: string | null;
    lastDrill: RestoreDrillSummary | null;
  };
  status?: {
    lastSuccess?: {
      backupId: string;
      createdAt: string;
      archiveBytes: number;
    } | null;
  };
}

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function restoreReasonText(reason: string | null): string {
  const map: Record<string, string> = {
    "missing-target": "هدف الاستعادة المعزول غير مهيأ بعد.",
    "missing-classification": "هدف الاستعادة يحتاج تصنيف staging أو test.",
    "unsafe-classification": "هدف الاستعادة الحالي غير آمن.",
    "target-not-dedicated": "هدف الاستعادة لم يُعتمد كقاعدة مخصصة قابلة للمسح.",
    "production-collision": "هدف الاستعادة يطابق Production وتم رفضه.",
  };
  return reason ? (map[reason] ?? reason) : "الاستعادة المعزولة غير متاحة.";
}

function protectionText(reason: BackupRecord["deletionProtection"]): string | null {
  if (reason === "only-verified") return "محمي: النسخة المتحققة الوحيدة";
  if (reason === "latest-verified") return "محمي: أحدث نسخة Verified";
  if (reason === "external-anchor") return "محمي: آخر نجاح لوجهة خارجية";
  return null;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export default function BackupRecoveryPage() {
  const [data, setData] = useState<BackupPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/backup", { cache: "no-store" });
      const payload = await json(response);
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "تعذّر تحميل النسخ.");
      setData(payload as unknown as BackupPayload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تحميل النسخ.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runBackup = async () => {
    setBusy("backup");
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/settings/backup/run", { method: "POST" });
      const payload = await json(response);
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "فشل النسخ.");
      setSuccess("اكتملت النسخة الجديدة وتم التحقق منها.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل النسخ.");
    } finally {
      setBusy(null);
    }
  };

  const deleteBackup = async () => {
    if (!deleteTarget || deleteReason.trim().length < 5) return;
    setBusy(`delete:${deleteTarget.backupId}`);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/settings/backup/archive/${encodeURIComponent(deleteTarget.backupId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason.trim(), confirmation: deleteTarget.backupId }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "تعذّر حذف النسخة.");
      setSuccess(`حُذفت النسخة القديمة وحررت ${sizeText(Number(payload.freedBytes ?? 0))} من المساحة.`);
      setDeleteTarget(null);
      setDeleteReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر حذف النسخة.");
    } finally {
      setBusy(null);
    }
  };

  const restoreDrill = async () => {
    if (!restoreTarget) return;
    setBusy(`restore:${restoreTarget.backupId}`);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/settings/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: restoreTarget.backupId, confirmation: restoreTarget.backupId }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "فشل اختبار الاستعادة.");
      setSuccess("نجح Restore Drill على الهدف المعزول وأصبحت النسخة READY FOR CUTOVER.");
      setRestoreTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل اختبار الاستعادة.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto max-w-5xl p-4 pb-20" dir="rtl">
      <PageHeader
        title="إدارة النسخ والاستعادة"
        subtitle="للمدير فقط — النسخ Verified، الحذف المحمي، واختبار الاستعادة المعزول"
        links={[
          { href: "/settings", label: "‹ الإعدادات" },
          { href: "/settings/backup", label: "إدارة النسخ", current: true },
        ]}
      />

      {error ? <div role="alert" className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      {success ? <div role="status" className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{success}</div> : null}

      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-black text-navy-950">التحكم بالطوارئ</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              الاستعادة هنا لا تكتب فوق Production. تُجرَّب النسخة أولًا على قاعدة staging/test مخصصة ثم تعطي READY FOR CUTOVER.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} disabled={loading}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">
              تحديث
            </button>
            <button type="button" onClick={() => void runBackup()} disabled={busy !== null}
              className="rounded-xl bg-navy-950 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
              {busy === "backup" ? "جارٍ النسخ…" : "نسخ الآن"}
            </button>
          </div>
        </div>
      </section>

      {data ? (
        <section className="mb-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center">
            <p className="text-2xl font-black text-navy-950">{data.storage.verifiedCount}</p>
            <p className="mt-1 text-xs font-bold text-slate-500">نسخة Verified محفوظة</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center">
            <p className="text-2xl font-black text-navy-950">{sizeText(data.storage.totalArchiveBytes)}</p>
            <p className="mt-1 text-xs font-bold text-slate-500">إجمالي مساحة النسخ المتحققة</p>
          </div>
        </section>
      ) : null}

      <section className={`mb-4 rounded-2xl border p-4 ${data?.restore.available ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <h2 className="text-sm font-black">Restore Drill</h2>
        {data?.restore.available ? (
          <p className="mt-1 text-xs text-emerald-900">
            الهدف المعزول جاهز ({data.restore.targetEnvironment}). يمكنك اختبار أي نسخة قبل قرار التحويل للإنتاج.
          </p>
        ) : (
          <p className="mt-1 text-xs text-amber-900">{restoreReasonText(data?.restore.reason ?? null)}</p>
        )}
        {data?.restore.lastDrill ? (
          <div className="mt-3 rounded-xl bg-white/80 p-3 text-xs">
            <strong>آخر اختبار:</strong> {data.restore.lastDrill.status === "ready" ? "READY FOR CUTOVER" : data.restore.lastDrill.status}
            {" · "}{data.restore.lastDrill.documentsVerified} مستند متحقق
            {" · "}{data.restore.lastDrill.tablesCount} جدول
            {typeof data.restore.lastDrill.durationMs === "number" ? ` · ${(data.restore.lastDrill.durationMs / 1000).toFixed(1)} ث` : ""}
          </div>
        ) : null}
      </section>

      {loading ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">جارٍ تحميل النسخ…</section>
      ) : data?.history?.length ? (
        <section className="space-y-3">
          {data.history.map((record) => {
            const protection = protectionText(record.deletionProtection);
            const restoring = busy === `restore:${record.backupId}`;
            const deleting = busy === `delete:${record.backupId}`;
            return (
              <article key={record.backupId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700">VERIFIED</span>
                      <span className="text-[10px] font-bold text-slate-500">{record.triggerType === "manual" ? "يدوي" : "مجدول"}</span>
                      {protection ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800">{protection}</span> : null}
                    </div>
                    <h3 className="mt-2 break-all text-xs font-black text-navy-950">{record.backupId}</h3>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {new Date(record.createdAt).toLocaleString("ar-YE")} · {sizeText(record.archiveBytes)} · {record.documentCount} مستند
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">SHA {record.archiveSha256.slice(0, 16)}…</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={!data.restore.available || busy !== null}
                      onClick={() => { setRestoreTarget(record); setDeleteTarget(null); }}
                      className="rounded-xl border border-brand-blue bg-white px-3 py-2 text-xs font-black text-brand-blue disabled:opacity-40">
                      {restoring ? "جارٍ الاختبار…" : "اختبار الاستعادة"}
                    </button>
                    <button type="button" disabled={Boolean(record.deletionProtection) || busy !== null}
                      onClick={() => { setDeleteTarget(record); setRestoreTarget(null); setDeleteReason(""); }}
                      className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700 disabled:opacity-40">
                      {deleting ? "جارٍ الحذف…" : "حذف النسخة"}
                    </button>
                  </div>
                </div>

                {restoreTarget?.backupId === record.backupId ? (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-black text-amber-900">تأكيد Restore Drill</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
                      سيُمسح هدف الاستعادة المخصص staging/test ثم تُستعاد هذه النسخة إليه. Production لن يُلمس.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void restoreDrill()} disabled={busy !== null}
                        className="rounded-xl bg-navy-950 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
                        تأكيد اختبار الاستعادة
                      </button>
                      <button type="button" onClick={() => setRestoreTarget(null)} disabled={busy !== null}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700">إلغاء</button>
                    </div>
                  </div>
                ) : null}

                {deleteTarget?.backupId === record.backupId ? (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="text-xs font-black text-red-900">حذف نهائي من القرص الدائم</p>
                    <p className="mt-1 text-[11px] text-red-800">السجل سيبقى كشهادة حذف، لكن ملف الأرشيف نفسه سيُزال لتحرير المساحة.</p>
                    <input value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="سبب الحذف — مثال: نسخة قديمة بعد تحقق النسخة الأحدث"
                      className="mt-3 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm" />
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void deleteBackup()}
                        disabled={busy !== null || deleteReason.trim().length < 5}
                        className="rounded-xl bg-red-700 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
                        تأكيد حذف النسخة
                      </button>
                      <button type="button" onClick={() => { setDeleteTarget(null); setDeleteReason(""); }} disabled={busy !== null}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700">إلغاء</button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          لا توجد نسخ Verified متاحة على القرص الدائم.
        </section>
      )}

      <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
        <strong>حماية المساحة والرجوع:</strong> أحدث نسخة Verified والنسخة الوحيدة لا يمكن حذفها. الحذف اليدوي لا يغيّر قاعدة البيانات، والاستعادة النهائية إلى Production لا تتم تلقائيًا من هذه الصفحة.
      </section>

      <div className="mt-4">
        <Link href="/settings" className="text-xs font-bold text-brand-blue">العودة إلى الإعدادات المركزية</Link>
      </div>
    </main>
  );
}
