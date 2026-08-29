"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * تبويب السيفالو في ملف المريض.
 *
 * قائمة تحليلاته، وفتح مسودة جديدة على شععة من مستنداته ببياناتها السريرية:
 * مرحلة العلاج، تاريخ الشععة، حالة التقويم المرتبطة، والمجموعة المرجعية.
 * والقاعدة هنا كما في التقويم: التحليل على شععة **موجودة** في المستندات —
 * لا رفعٌ من هنا، فالرفع وحدةٌ واحدة لها قواعدها وتكرارُها بابٌ ثانٍ للتسرب.
 */

interface CephAnalysis {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  orthoCaseId: number | null;
  phase: "pretreatment" | "during" | "posttreatment" | "followup";
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
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

interface OrthoCaseLite {
  id: number;
  status?: string;
  appliance?: string;
}

interface RefSetLite {
  key: string;
  name: string;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "معتمد", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  during: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

const fmt = (v: number | null): string => (v == null || !Number.isFinite(v) ? "—" : String(Math.round(v * 10) / 10));

export function PatientCeph({ patientId }: { patientId: number }) {
  const [analyses, setAnalyses] = useState<CephAnalysis[] | null>(null);
  const [documents, setDocuments] = useState<PatientDocument[] | null>(null);
  const [images, setImages] = useState<PatientDocument[]>([]);
  const [orthoCases, setOrthoCases] = useState<OrthoCaseLite[]>([]);
  const [refSets, setRefSets] = useState<RefSetLite[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);
  const [phase, setPhase] = useState("pretreatment");
  const [xrayDate, setXrayDate] = useState("");
  const [device, setDevice] = useState("");
  const [orthoCaseId, setOrthoCaseId] = useState("");
  const [refSet, setRefSet] = useState("builtin_default");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cephRes, docsRes, orthoRes, refsRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/ceph`),
        fetch(`/api/patients/${patientId}/documents`),
        fetch(`/api/ortho?patientId=${patientId}`),
        fetch("/api/ceph-reference-sets"),
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
      if (orthoRes.ok) {
        const data = await orthoRes.json();
        setOrthoCases((data.cases ?? []) as OrthoCaseLite[]);
      }
      if (refsRes.ok) {
        const data = await refsRes.json();
        setRefSets((data.sets ?? []) as RefSetLite[]);
      }
    } catch {
      setError("تعذّر الاتصال.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const studiesOnSelected = (selectedDoc != null && analyses != null)
    ? analyses.filter((a) => a.documentId === selectedDoc)
    : [];

  const openDraft = async () => {
    if (!selectedDoc) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}/ceph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: selectedDoc,
          phase,
          xrayDate: xrayDate || null,
          device: device || null,
          orthoCaseId: orthoCaseId ? Number(orthoCaseId) : null,
          refSet: refSet || null,
        }),
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
        <p className="mb-3 text-sm font-medium text-slate-700">دراسة سيفالومترية جديدة</p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              الشععة — من مستندات المريض
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
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">مرحلة العلاج</label>
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={phase}
              onChange={(e) => setPhase(e.target.value)}
            >
              <option value="pretreatment">قبل العلاج</option>
              <option value="during">أثناء العلاج</option>
              <option value="posttreatment">بعد العلاج</option>
              <option value="followup">متابعة</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">تاريخ الشععة</label>
            <input
              type="date"
              value={xrayDate}
              onChange={(e) => setXrayDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              حالة التقويم المرتبطة (اختياري)
            </label>
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={orthoCaseId}
              onChange={(e) => setOrthoCaseId(e.target.value)}
            >
              <option value="">بدون ربط</option>
              {orthoCases.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.id}{c.status ? ` — ${c.status}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              المجموعة المرجعية
            </label>
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={refSet}
              onChange={(e) => setRefSet(e.target.value)}
            >
              {refSets.length === 0 && <option value="builtin_default">المرجع العام المدمج</option>}
              {refSets.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              الجهاز/المركز (اختياري)
            </label>
            <input
              type="text"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              maxLength={120}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="مثال: جهاز المركز الرئيسي"
            />
          </div>
        </div>

        {studiesOnSelected.length > 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            تنبيه تكرار: لهذه الشععة {studiesOnSelected.length} دراسة سابقة
            ({studiesOnSelected.map((a) => `#${a.id}`).join("، ")}) — تابع فقط إن كان فتح دراسةٍ أخرى مقصودًا.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void openDraft()}
            disabled={!selectedDoc || creating || images.length === 0}
            className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {creating ? "يفتح…" : "فتح دراسة جديدة"}
          </button>
          <p className="text-xs text-slate-500">
            العمر وقت الشععة يُحسب تلقائيًا من تاريخ الميلاد وتاريخ الشععة عند العرض،
            والرسم على الشععة لا ينسخها — تُقرأ من مستندات المريض كما هي.
            مسودة واحدة لكل مريض.
          </p>
        </div>
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
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-right text-xs text-slate-500">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">الحالة</th>
                <th className="px-3 py-2 font-medium">المرحلة</th>
                <th className="px-3 py-2 font-medium">تاريخ الشععة</th>
                <th className="px-3 py-2 font-medium">المعايرة</th>
                <th className="px-3 py-2 font-medium">أهم النتائج</th>
                <th className="px-3 py-2 font-medium">فُتح</th>
                <th className="px-3 py-2 font-medium">اعتمد</th>
                <th className="px-3 py-2 font-medium">ملاحظة</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {analyses.map((a) => {
                const st = STATUS[a.status] ?? { label: a.status, cls: "bg-slate-50 text-slate-600 border-slate-200" };
                return (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{a.id}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{PHASE_LABEL[a.phase] ?? a.phase}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {a.xrayDate ? friendlyDateLong(a.xrayDate) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {a.mmPerPixel != null ? (
                        <span className="text-emerald-700">معايرة {(1 / a.mmPerPixel).toFixed(1)} بكسل/مم</span>
                      ) : (
                        <span className="text-amber-600">بلا معايرة</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">
                      {a.findings ? (
                        <span title="ANB · FMA · WITS من لقطة الاعتماد">
                          ANB {fmt(a.findings.anb)} · FMA {fmt(a.findings.fma)} · W {fmt(a.findings.wits)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {friendlyDateLong(a.createdAt.slice(0, 10))} — {a.createdBy}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {a.completedAt
                        ? `${friendlyDateLong(a.completedAt.slice(0, 10))} — ${a.completedBy}`
                        : "—"}
                    </td>
                    <td className="max-w-48 truncate px-3 py-2 text-xs text-slate-500">{a.note ?? "—"}</td>
                    <td className="px-3 py-2 text-left">
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
