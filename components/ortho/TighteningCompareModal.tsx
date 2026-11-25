"use client";

import { useMemo, useState } from "react";
import { Columns2, X } from "lucide-react";
import { PHOTO_VIEW_LABEL, type PhotoView } from "@/lib/ortho-photos";
import { parseTighteningPhotoMeta, PHOTO_TIMING_LABEL } from "@/lib/ortho-tightening-media";

export interface ComparableSessionPhoto {
  id: number;
  title: string;
  photoView: string | null;
  note?: string | null;
}

export interface ComparableAdjustmentSession {
  id: number;
  sessionNumber: number;
  doneOn: string;
  recordedBy: string;
  upperWire: string | null;
  lowerWire: string | null;
  photos: ComparableSessionPhoto[];
}

interface TighteningCompareModalProps {
  open: boolean;
  sessions: ComparableAdjustmentSession[];
  initialCurrentId: number | null;
  onClose: () => void;
}

export function TighteningCompareModal({
  open,
  sessions,
  initialCurrentId,
  onClose,
}: TighteningCompareModalProps) {
  const defaultCurrent = initialCurrentId ?? sessions[0]?.id ?? null;
  const defaultPrev = sessions.find((s) => s.id !== defaultCurrent)?.id ?? defaultCurrent;

  const [currentId, setCurrentId] = useState<number | null>(defaultCurrent);
  const [previousId, setPreviousId] = useState<number | null>(defaultPrev);
  const [viewFilter, setViewFilter] = useState<string>("all");

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === (currentId ?? defaultCurrent)) ?? sessions[0] ?? null,
    [sessions, currentId, defaultCurrent],
  );
  const previousSession = useMemo(
    () => sessions.find((s) => s.id === (previousId ?? defaultPrev)) ?? sessions[1] ?? sessions[0] ?? null,
    [sessions, previousId, defaultPrev],
  );

  if (!open || !currentSession) return null;

  const filterPhotos = (photos: ComparableSessionPhoto[]) =>
    viewFilter === "all" ? photos : photos.filter((p) => (p.photoView ?? "extra") === viewFilter);

  const renderSessionColumn = (titleLabel: string, session: ComparableAdjustmentSession | null) => {
    if (!session) return null;
    const list = filterPhotos(session.photos);
    return (
      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
          <div>
            <p className="text-[11px] font-bold text-brand-blue">{titleLabel}</p>
            <h4 className="text-sm font-black text-slate-900">
              شدّة رقم #{session.sessionNumber} · {session.doneOn}
            </h4>
            <p className="text-[11px] text-slate-600">
              الطبيب/الموثّق: <strong>{session.recordedBy}</strong>
              {(session.upperWire || session.lowerWire) && (
                <span className="ms-2 font-mono" dir="ltr">
                  (U: {session.upperWire || "—"} / L: {session.lowerWire || "—"})
                </span>
              )}
            </p>
          </div>
          <span className="rounded-full bg-white border border-slate-200 px-2.5 py-0.5 text-[11px] font-bold text-slate-700">
            {list.length} صورة
          </span>
        </div>

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-xs text-slate-400">
            لا توجد صور مطابقة لهذا التصنيف في هذه الشدّة.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {list.map((photo) => {
              const meta = parseTighteningPhotoMeta(photo.note);
              const viewText =
                photo.photoView && photo.photoView in PHOTO_VIEW_LABEL
                  ? PHOTO_VIEW_LABEL[photo.photoView as PhotoView]
                  : "صورة إضافية";
              return (
                <div key={photo.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="h-44 bg-slate-900 flex items-center justify-center">
                    <img
                      src={`/api/documents/${photo.id}`}
                      alt={photo.title}
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <div className="p-2.5 text-[11px] space-y-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-bold text-slate-800">{viewText}</span>
                      {meta.timing && (
                        <span className="rounded bg-brand-blue/10 px-1.5 py-0.5 font-semibold text-brand-blue">
                          {PHOTO_TIMING_LABEL[meta.timing]}
                        </span>
                      )}
                      {meta.isDerived && (
                        <span className="rounded bg-teal-50 px-1.5 py-0.5 font-semibold text-teal-800">نسخة مشتقة</span>
                      )}
                    </div>
                    {meta.cleanNote && <p className="text-slate-600">{meta.cleanNote}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs" dir="rtl">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Columns2 className="h-4 w-4 text-brand-blue" />
            <h3 className="text-sm font-bold text-slate-900">مقارنة صور الشدّات المتتابعة (قبل / بعد / بين الجلسات)</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-700">الجلسة الأولى:</span>
            <select
              value={currentSession.id}
              onChange={(e) => setCurrentId(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  شدّة #{s.sessionNumber} — {s.doneOn} ({s.recordedBy})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-700">مقارنة مع:</span>
            <select
              value={previousSession?.id ?? ""}
              onChange={(e) => setPreviousId(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  شدّة #{s.sessionNumber} — {s.doneOn} ({s.recordedBy})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-700">تصفية المنظر:</span>
            <select
              value={viewFilter}
              onChange={(e) => setViewFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
            >
              <option value="all">جميع المناظر</option>
              {(Object.keys(PHOTO_VIEW_LABEL) as PhotoView[]).map((k) => (
                <option key={k} value={k}>
                  {PHOTO_VIEW_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
          {renderSessionColumn("الجلسة المختارة", currentSession)}
          {renderSessionColumn("الجلسة المقارَنة", previousSession)}
        </div>
      </div>
    </div>
  );
}
