"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * تبويب السيفالو في ملف المريض.
 *
 * قائمة تحليلاته، وفتح مسودة جديدة على شععة من مستنداته. والقاعدة هنا كما في
 * التقويم: التحليل على شععة **موجودة** في المستندات — لا رفعٌ من هنا، فالرفع
 * وحدةٌ واحدة لها قواعدها (الحجم والنوع والقرص الدائم) وتكرارُها بابُ ثانٍ
 * للتسرب.
 */

interface CephAnalysis {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
}

interface PatientDocument {
  id: number;
  title: string;
  isImage: boolean;
  mimeType: string;
  takenOn: string | null;
  uploadedAt: string;
  removedAt: string | null;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "معتمد", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

export function PatientCeph({ patientId }: { patientId: number }) {
  const [analyses, setAnalyses] = useState<CephAnalysis[] | null>(null);
  const [documents, setDocuments] = useState<PatientDocument[] | null>(null);
  const [images, setImages] = useState<PatientDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cephRes, docsRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/ceph`),
        fetch(`/api/patients/${patientId}/documents`),
      ]);
      if (cephRes.ok) setAnalyses((await cephRes.json()).analyses);
      else setError("تعذّر تحميل التحليلات.");
      if (docsRes.ok) {
        const data = await docsRes.json();
        const docs: PatientDocument[] = data.documents ?? [];
        setDocuments(docs);
        const imgs = docs.filter((d) => d.isImage);
        setImages(imgs);
        setSelectedDoc((prev) => prev ?? imgs[0]?.id ?? null);
      }
    } catch {
      setError("تعذّر الاتصال.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const openDraft = async () => {
    if (!selectedDoc) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}/ceph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: selectedDoc }),
      });
      const data = await res.json();
      if (res.ok) window.location.href = `/ceph/${data.id}`;
      else setError(data.message ?? "تعذّر فتح التحليل.");
    } catch {
      setError("تعذّر الاتصال.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* فتح مسودة جديدة */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              شععة جديدة للتحليل — من مستندات المريض
            </label>
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={selectedDoc ?? ""}
              onChange={(e) => setSelectedDoc(Number(e.target.value) || null)}
            >
              {images.length === 0 && <option value="">لا صور في مستندات المريض</option>}
              {images.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  #{doc.id} — {doc.title}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void openDraft()}
            disabled={!selectedDoc || creating || images.length === 0}
            className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {creating ? "يفتح…" : "فتح تحليل جديد"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          الرسم على الشععة لا ينسخها: تُقرأ من مستندات المريض بجلسةٍ كما هي، والتحليل
          يحفظ النقاط والقياسات وحدها. مسودة واحدة لكل مريض — أكملها أو ارفضها قبل فتح أخرى.
        </p>
        {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>

      {/* القائمة */}
      {analyses == null ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">يحمل…</p>
      ) : analyses.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          لا تحليلات سيفالومترية بعد.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-right text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">الحالة</th>
                <th className="px-4 py-2 font-medium">المعايرة</th>
                <th className="px-4 py-2 font-medium">فُتح</th>
                <th className="px-4 py-2 font-medium">اعتمد</th>
                <th className="px-4 py-2 font-medium">ملاحظة</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {analyses.map((a) => {
                const st = STATUS[a.status] ?? { label: a.status, cls: "bg-slate-50 text-slate-600 border-slate-200" };
                return (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{a.id}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {a.mmPerPixel != null ? (
                        <span className="text-emerald-700">معايرة {(1 / a.mmPerPixel).toFixed(1)} بكسل/مم</span>
                      ) : (
                        <span className="text-amber-600">بلا معايرة</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {friendlyDateLong(a.createdAt.slice(0, 10))} — {a.createdBy}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {a.completedAt
                        ? `${friendlyDateLong(a.completedAt.slice(0, 10))} — ${a.completedBy}`
                        : "—"}
                    </td>
                    <td className="max-w-48 truncate px-4 py-2 text-xs text-slate-500">{a.note ?? "—"}</td>
                    <td className="px-4 py-2 text-left">
                      <Link
                        href={`/ceph/${a.id}`}
                        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        فتح
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {documents == null && <p className="text-xs text-slate-400">يفحص مستندات المريض…</p>}
    </div>
  );
}
