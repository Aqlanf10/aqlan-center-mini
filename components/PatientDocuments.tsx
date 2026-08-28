"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KIND_LABEL, formatBytes, type DocumentKind } from "@/lib/storage";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";

/**
 * الأشعة والمستندات.
 *
 * أن تُفتح صورة الأشعة **في ملف المريض** لا في مجلّدٍ على جهازٍ في غرفة الأشعة هو
 * الفرق بين سجلٍّ يُقرأ وسجلٍّ يُبحث عنه. والأشعة القديمة أثمن ما في الملف: المقارنة
 * بين اليوم وقبل سنة هي التشخيص نفسه في كثيرٍ من الحالات.
 */

interface PatientDocument {
  id: number;
  visitId: number | null;
  kind: DocumentKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  note: string | null;
  takenOn: string | null;
  uploadedBy: string;
  uploadedAt: string;
  removedAt: string | null;
  removedBy: string | null;
  removedNote: string | null;
}

const KINDS = Object.keys(KIND_LABEL) as DocumentKind[];

export function PatientDocuments({ patientId }: { patientId: number }) {
  const session = useSession();
  const admin = isAdmin(session?.role);
  const today = clinicDateString(new Date(), "Asia/Aden");

  const [documents, setDocuments] = useState<PatientDocument[]>([]);
  const [ready, setReady] = useState(true);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<PatientDocument | null>(null);

  const [kind, setKind] = useState<DocumentKind>("xray");
  const [title, setTitle] = useState("");
  const [takenOn, setTakenOn] = useState(today);
  const [picked, setPicked] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setDocuments(payload.documents as PatientDocument[]);
      setReady(Boolean(payload.storageReady));
      setStorageMessage(payload.storageMessage ?? null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("title", title.trim() || file.name);
      form.set("takenOn", takenOn);
      const response = await fetch(`/api/patients/${patientId}/documents`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الرفع."); return; }
      setTitle("");
      setPicked(null);
      if (fileInput.current) fileInput.current.value = "";
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const hide = async (document: PatientDocument) => {
    const note = window.prompt(`سبب إخفاء «${document.title}»؟`);
    if (!note?.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الإخفاء."); return; }
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/*
        * تخزينٌ غير مهيَّأ يُقال قبل أن يختار أحدٌ ملفًّا — لا بعد أن يرفعه فيفشل.
        * وبلا هذا كان الرفع سينجح ظاهريًّا ثم تختفي الأشعة عند أول إعادة نشر.
        */}
      {!ready && storageMessage ? (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          {storageMessage.split("\n").map((line, index) => (
            <p key={index}
              className={index === 0
                ? "mb-1 text-sm font-bold text-amber-900"
                : "text-[11px] leading-6 text-amber-800"}>
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <form onSubmit={upload} className="mb-3 rounded-2xl border border-slate-200 bg-white p-3">
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <label className="min-w-[7rem]">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">النوع</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as DocumentKind)}
              aria-label="نوع المستند"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {KINDS.map((value) => (
                <option key={value} value={value}>{KIND_LABEL[value]}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الوصف</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)}
              aria-label="وصف المستند" placeholder="بانورامي قبل العلاج"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
          <label className="w-36">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ التصوير</span>
            <input type="date" value={takenOn} onChange={(event) => setTakenOn(event.target.value)}
              aria-label="تاريخ التصوير"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        </div>
        {/*
          * زرّ اختيار الملف مكتوبٌ بالعربية.
          *
          * حقل `file` الأصلي يرسم زرًّا بلغة المتصفّح — «Choose File» و«No file
          * chosen» — فيبقى سطران إنجليزيّان وسط شاشةٍ عربية كاملة. وهو أوّل ما
          * تراه عين الاستقبال في هذه الشاشة. فيُخفى الحقل ويبقى عاملًا، ويُرسم
          * فوقه زرٌّ عربي يقول اسم الملف المختار.
          */}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" id="document-file" aria-label="ملف الأشعة"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(event) => setPicked(event.target.files?.[0]?.name ?? null)}
            className="sr-only" />
          <label htmlFor="document-file"
            className="cursor-pointer rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-800">
            اختر ملفًّا
          </label>
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">
            {picked ?? "لم يُختَر ملف بعد — صورة أو PDF"}
          </span>
          <button type="submit" disabled={busy || !ready || !picked}
            className="rounded-lg bg-navy-800 px-4 py-1.5 text-xs font-extrabold text-white disabled:opacity-40">
            {busy ? "جارٍ الرفع…" : "ارفع"}
          </button>
        </div>
      </form>

      {loading && documents.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : documents.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا أشعة ولا مستندات في هذا الملف.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((document) => (
            <li key={document.id}
              className={`overflow-hidden rounded-2xl border bg-white ${
                document.removedAt ? "border-slate-200 opacity-60" : "border-slate-200"
              }`}>
              <button type="button" onClick={() => setViewing(document)}
                className="block w-full text-right">
                {document.isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/documents/${document.id}`} alt={document.title}
                    loading="lazy"
                    className="h-36 w-full bg-slate-900 object-contain" />
                ) : (
                  <div className="flex h-36 w-full items-center justify-center bg-slate-100 text-3xl">📄</div>
                )}
                <div className="p-2.5">
                  <p className="truncate text-sm font-bold">{document.title}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {KIND_LABEL[document.kind]} · {formatBytes(document.sizeBytes)}
                    {document.takenOn ? ` · ${friendlyDateLong(document.takenOn)}` : ""}
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-2 border-t border-slate-100 px-2.5 py-1.5">
                <a href={`/api/documents/${document.id}?download=1`}
                  className="text-[11px] font-bold text-navy-800 underline decoration-slate-300 underline-offset-4">
                  نزّل
                </a>
                {document.removedAt ? (
                  <span className="text-[11px] text-slate-500">
                    مخفيّ — {document.removedBy}
                    {document.removedNote ? `: ${document.removedNote}` : ""}
                  </span>
                ) : admin ? (
                  <button type="button" onClick={() => void hide(document)} disabled={busy}
                    className="mr-auto text-[11px] font-bold text-slate-400 hover:text-red-600 disabled:opacity-40">
                    أخفِ
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewing ? (
        <div role="dialog" aria-label={viewing.title}
          onClick={() => setViewing(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl bg-white p-3"
            onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold">{viewing.title}</p>
                <p className="text-[11px] text-slate-500">
                  {KIND_LABEL[viewing.kind]} · رفعه {viewing.uploadedBy}
                  {viewing.takenOn ? ` · صُوّر ${friendlyDateLong(viewing.takenOn)}` : ""}
                </p>
              </div>
              <button type="button" onClick={() => setViewing(null)}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
                إغلاق
              </button>
            </div>
            {viewing.isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/documents/${viewing.id}`} alt={viewing.title}
                className="max-h-[70vh] w-full bg-slate-900 object-contain" />
            ) : (
              <iframe src={`/api/documents/${viewing.id}`} title={viewing.title}
                className="h-[70vh] w-full rounded-lg border border-slate-200" />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
