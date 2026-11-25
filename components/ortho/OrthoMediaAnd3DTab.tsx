"use client";

import React, { useEffect, useRef, useState } from "react";
import type { OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";

interface PatientDocumentItem {
  id: number;
  kind: string;
  title: string;
  takenOn: string | null;
  photoStage: string | null;
  photoView: string | null;
  adjustmentId: number | null;
  mimeType?: string;
  note?: string | null;
}

type MediaSubView = "gallery" | "photo_analysis" | "cbct_dicom" | "model_3d";

const FACIAL_LANDMARK_DEFS = [
  { key: "Tr", label: "Trichion (خط الشعر)" },
  { key: "G", label: "Glabella (بين الحاجبين)" },
  { key: "Sn", label: "Subnasale (تحت الأنف)" },
  { key: "Me", label: "Soft Menton (أسفل الذقن)" },
  { key: "ExR", label: "Exocanthion يمين" },
  { key: "ExL", label: "Exocanthion يسار" },
] as const;

export function OrthoMediaAnd3DTab({
  patientId,
  record,
  canEdit,
  canViewPhotos,
  canDownloadPhotos,
  canPhotoAnalysis,
  canModel3d,
  onChange,
}: {
  patientId: number;
  record: OrthoWorkspaceRecord;
  canEdit: boolean;
  canViewPhotos: boolean;
  canDownloadPhotos: boolean;
  canPhotoAnalysis: boolean;
  canModel3d: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const [subView, setSubView] = useState<MediaSubView>("gallery");
  const [docs, setDocs] = useState<PatientDocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLandmark, setActiveLandmark] = useState<string>("Tr");
  const photoImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!canViewPhotos) {
      setDocs([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled) {
          setDocs(Array.isArray(data) ? data : Array.isArray(data?.documents) ? data.documents : []);
        }
      })
      .catch(() => {
        if (!cancelled) setDocs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, canViewPhotos]);

  const photos = docs.filter((d) => d.kind === "photo" || d.mimeType?.startsWith("image/"));
  const radiographs = docs.filter((d) => d.kind === "xray" || d.kind === "ceph" || d.kind === "cbct");

  const handlePhotoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEdit || !canPhotoAnalysis) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Number(((e.clientX - rect.left) / rect.width).toFixed(4));
    const y = Number(((e.clientY - rect.top) / rect.height).toFixed(4));
    onChange({
      ...record,
      facialPhoto: {
        ...record.facialPhoto,
        landmarks: { ...record.facialPhoto.landmarks, [activeLandmark]: { x, y } },
      },
    });
  };

  // Compute facial vertical thirds only when all 4 vertical points exist
  const lm = record.facialPhoto.landmarks;
  const facialThirds =
    lm.Tr && lm.G && lm.Sn && lm.Me
      ? (() => {
          const upper = Math.abs(lm.G.y - lm.Tr.y);
          const middle = Math.abs(lm.Sn.y - lm.G.y);
          const lower = Math.abs(lm.Me.y - lm.Sn.y);
          const total = upper + middle + lower;
          if (total <= 0) return null;
          return {
            upperPct: Number(((upper / total) * 100).toFixed(1)),
            middlePct: Number(((middle / total) * 100).toFixed(1)),
            lowerPct: Number(((lower / total) * 100).toFixed(1)),
          };
        })()
      : null;

  const is2DModality = record.cbct.modality !== "cbct_3d_volume";

  return (
    <div className="space-y-4">
      {/* Sub-studio switcher */}
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-white p-2">
        <button
          type="button"
          onClick={() => setSubView("gallery")}
          className={`rounded-lg px-3 py-1.5 text-xs font-extrabold ${
            subView === "gallery" ? "bg-navy-800 text-white" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          أرشيف الصور والأشعة ({docs.length})
        </button>
        {canPhotoAnalysis ? (
          <button
            type="button"
            onClick={() => setSubView("photo_analysis")}
            className={`rounded-lg px-3 py-1.5 text-xs font-extrabold ${
              subView === "photo_analysis" ? "bg-navy-800 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            تحليل الصور الوجهية
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setSubView("cbct_dicom")}
          className={`rounded-lg px-3 py-1.5 text-xs font-extrabold ${
            subView === "cbct_dicom" ? "bg-navy-800 text-white" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          استوديو الأشعة وCBCT / DICOM
        </button>
        {canModel3d ? (
          <button
            type="button"
            onClick={() => setSubView("model_3d")}
            className={`rounded-lg px-3 py-1.5 text-xs font-extrabold ${
              subView === "model_3d" ? "bg-navy-800 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            النماذج ثلاثية الأبعاد (3D)
          </button>
        ) : null}
      </div>

      {/* 1. Unified Gallery */}
      {subView === "gallery" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-navy-900">الأرشيف الموحّد لصور وأشعة المريض</h3>
            <span className="text-[11px] text-slate-500">
              مرتبط تلقائيًا بصور الشدّات وأرشيف الملف
            </span>
          </div>
          {!canViewPhotos ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-900">
              صلاحية «رؤية الصور والأشعة» غير مفعّلة لهذا الحساب وفق إعدادات الخصوصية.
            </p>
          ) : loading ? (
            <p className="text-xs text-slate-500">جارٍ تحميل الأرشيف…</p>
          ) : docs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
              لا توجد صور أو أشعة مرفوعة بعد. يمكنك التصوير المباشر من تبويب «الشدّات والجلسات» أو رفع الملفات من «الأشعة والملفات».
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {docs.map((doc) => (
                <div key={doc.id} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 flex flex-col">
                  <div className="aspect-[4/3] bg-slate-900/5 flex items-center justify-center overflow-hidden">
                    <img
                      src={`/api/documents/${doc.id}`}
                      alt={doc.title}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="p-2.5 space-y-1 text-[11px]">
                    <p className="truncate font-bold text-slate-900">{doc.title}</p>
                    <p className="text-slate-500">
                      {doc.takenOn ?? "—"} {doc.photoView ? `· ${doc.photoView}` : ""}
                      {doc.adjustmentId ? ` · شدّة #${doc.adjustmentId}` : ""}
                    </p>
                    {canDownloadPhotos ? (
                      <a
                        href={`/api/documents/${doc.id}?download=1`}
                        className="inline-block text-[11px] font-bold text-navy-800 underline"
                      >
                        تنزيل
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2. Facial Photo Analysis Studio */}
      {subView === "photo_analysis" && canPhotoAnalysis && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-extrabold text-navy-900">استوديو تحليل الصور الوجهية (Facial Proportions)</h3>
              <p className="text-[11px] text-slate-500">
                اختر صورة وجهية أمامية أو جانبية ثم ضع المعالم التشريحية لحساب الأثلاث الوجهية (Rule of Thirds).
              </p>
            </div>
            <select
              disabled={!canEdit}
              value={record.facialPhoto.documentId ?? ""}
              onChange={(e) =>
                onChange({
                  ...record,
                  facialPhoto: {
                    ...record.facialPhoto,
                    documentId: e.target.value ? Number(e.target.value) : null,
                  },
                })
              }
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="">— اختر صورة من الأرشيف —</option>
              {photos.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} · {p.title} ({p.takenOn ?? "—"})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              {record.facialPhoto.documentId && canViewPhotos ? (
                <div
                  onClick={handlePhotoClick}
                  className="relative cursor-crosshair overflow-hidden rounded-xl border border-slate-300 bg-slate-900"
                >
                  <img
                    ref={photoImgRef}
                    src={`/api/documents/${record.facialPhoto.documentId}`}
                    alt="تحليل وجهي"
                    className="max-h-[420px] w-full object-contain select-none"
                  />
                  {Object.entries(lm).map(([k, pt]) => (
                    <span
                      key={k}
                      style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
                      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-xs text-slate-500">
                  اختر صورة وجهية من القائمة أعلاه لبدء تعيين المعالم.
                </div>
              )}
            </div>

            <div className="space-y-3 text-xs">
              <p className="font-bold text-slate-700">المعلم النشط للنقر:</p>
              <div className="space-y-1">
                {FACIAL_LANDMARK_DEFS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setActiveLandmark(item.key)}
                    className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-right ${
                      activeLandmark === item.key
                        ? "border-navy-800 bg-navy-800 text-white"
                        : "border-slate-200 bg-slate-50 text-slate-800"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px]">{lm[item.key] ? "✓" : "—"}</span>
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5">
                <p className="font-extrabold text-navy-900">نتائج الأثلاث الوجهية (Rule of Thirds)</p>
                {facialThirds ? (
                  <ul className="space-y-1 text-[11px]">
                    <li>الثلث العلوي (Tr–G): <strong>{facialThirds.upperPct}%</strong> (المرجع ~33.3%)</li>
                    <li>الثلث الأوسط (G–Sn): <strong>{facialThirds.middlePct}%</strong> (المرجع ~33.3%)</li>
                    <li>الثلث السفلي (Sn–Me): <strong>{facialThirds.lowerPct}%</strong> (المرجع ~33.3%)</li>
                  </ul>
                ) : (
                  <p className="text-[11px] text-amber-800">
                    لا تُحسب النسب قبل تعيين المعالم الأربعة: Tr, G, Sn, Me.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. CBCT / DICOM Guarded Studio */}
      {subView === "cbct_dicom" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-extrabold text-navy-900">استوديو الأشعة والـ CBCT / DICOM</h3>
              <p className="text-[11px] text-slate-500">
                فصل علمي صارم بين القياسات ثنائية الأبعاد (2D) والقياسات الحجمية ثلاثية الأبعاد (3D).
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                is2DModality ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"
              }`}
            >
              {is2DModality ? "وضع 2D: القياسات الحجمية 3D محجوبة علميًا" : "وضع حجمي CBCT 3D (معايرة مطلوبة)"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="font-bold text-slate-700">نوع الشععة (Modality)</span>
              <select
                disabled={!canEdit}
                value={record.cbct.modality}
                onChange={(e) =>
                  onChange({
                    ...record,
                    cbct: { ...record.cbct, modality: e.target.value as typeof record.cbct.modality },
                  })
                }
                className="w-full rounded-lg border border-slate-300 bg-white p-2"
              >
                <option value="cbct_2d_slice">مقطع 2D من CBCT (ثنائي الأبعاد فقط)</option>
                <option value="cbct_3d_volume">حجم CBCT 3D كامل (DICOM Volume)</option>
                <option value="opg_2d">بانوراما OPG (2D)</option>
                <option value="lateral_ceph_2d">سيفالومتري جانبي (2D)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">معايرة DICOM Pixel Spacing (mm/px)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                disabled={!canEdit}
                value={record.cbct.pixelSpacingMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    cbct: { ...record.cbct, pixelSpacingMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                placeholder="مثال: 0.20"
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">سُمك المقطع Slice Thickness (mm)</span>
              <input
                type="number"
                step="0.1"
                min="0"
                disabled={!canEdit}
                value={record.cbct.sliceThicknessMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    cbct: { ...record.cbct, sliceThicknessMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                placeholder="مثال: 0.3"
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
          </div>

          {record.cbct.pixelSpacingMm == null || record.cbct.pixelSpacingMm <= 0 ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 font-bold text-red-900">
              تنبيه علمي: لا توجد معايرة (Pixel Spacing / Voxel Size) مسجّلة؛ يُمنع استخراج قياسات مليمترية أو حجمية قبل التحقق من المعايرة.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1">
              <span className="font-bold text-slate-700">تقييم الأسنان المنطمرة (Impactions)</span>
              <textarea
                rows={3}
                disabled={!canEdit}
                value={record.cbct.impactionNotes}
                onChange={(e) => onChange({ ...record, cbct: { ...record.cbct, impactionNotes: e.target.value } })}
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">ملاحظات امتصاص الجذور والعظم السنخي</span>
              <textarea
                rows={3}
                disabled={!canEdit}
                value={record.cbct.rootResorptionNotes}
                onChange={(e) => onChange({ ...record, cbct: { ...record.cbct, rootResorptionNotes: e.target.value } })}
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">ملاحظات مجرى الهواء (Airway)</span>
              <textarea
                rows={3}
                disabled={!canEdit}
                value={record.cbct.airwayNotes}
                onChange={(e) => onChange({ ...record, cbct: { ...record.cbct, airwayNotes: e.target.value } })}
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
          </div>
          {radiographs.length > 0 ? (
            <p className="text-[11px] text-slate-500">الأشعة المرتبطة في الأرشيف: {radiographs.length} ملف.</p>
          ) : null}
        </div>
      )}

      {/* 4. 3D Models Studio */}
      {subView === "model_3d" && canModel3d && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4 text-xs">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">تحليل النماذج الرقمية ثلاثية الأبعاد (3D Models — STL / OBJ)</h3>
            <p className="text-[11px] text-slate-500">
              يتم تحميل النماذج ثلاثية الأبعاد حصريًا عبر المسار المصادَق عليه `/api/documents/[id]` مع توثيق المعايرة بالمليمتر.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="font-bold text-slate-700">عرض بين الأنياب علوي (mm)</span>
              <input
                type="number"
                step="0.1"
                disabled={!canEdit}
                value={record.model3d.intercanineUpperMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, intercanineUpperMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">عرض بين الأنياب سفلي (mm)</span>
              <input
                type="number"
                step="0.1"
                disabled={!canEdit}
                value={record.model3d.intercanineLowerMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, intercanineLowerMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">عرض بين الأرحاء علوي (mm)</span>
              <input
                type="number"
                step="0.1"
                disabled={!canEdit}
                value={record.model3d.intermolarUpperMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, intermolarUpperMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">عرض بين الأرحاء سفلي (mm)</span>
              <input
                type="number"
                step="0.1"
                disabled={!canEdit}
                value={record.model3d.intermolarLowerMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, intermolarLowerMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">عمق قبة الحنك (mm)</span>
              <input
                type="number"
                step="0.1"
                disabled={!canEdit}
                value={record.model3d.palatalDepthMm ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, palatalDepthMm: e.target.value ? Number(e.target.value) : null },
                  })
                }
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
            <label className="space-y-1">
              <span className="font-bold text-slate-700">معامل المعايرة (mm/unit)</span>
              <input
                type="number"
                step="0.01"
                disabled={!canEdit}
                value={record.model3d.calibratedMmPerUnit ?? ""}
                onChange={(e) =>
                  onChange({
                    ...record,
                    model3d: { ...record.model3d, calibratedMmPerUnit: e.target.value ? Number(e.target.value) : null },
                  })
                }
                placeholder="1.00"
                className="w-full rounded-lg border border-slate-300 p-2"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="font-bold text-slate-700">ملاحظات المسح ثلاثي الأبعاد والنماذج</span>
            <textarea
              rows={3}
              disabled={!canEdit}
              value={record.model3d.notes}
              onChange={(e) => onChange({ ...record, model3d: { ...record.model3d, notes: e.target.value } })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
        </div>
      )}
    </div>
  );
}
