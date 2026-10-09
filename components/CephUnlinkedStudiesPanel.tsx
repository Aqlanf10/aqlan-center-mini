"use client";

import { useEffect, useRef, useState } from "react";
import { friendlyDateLong } from "@/lib/reminders";
import { CEPH_DIAGNOSTIC_STAGES, type CephDiagnosticStage } from "@/lib/ortho";

/**
 * (ORTHO-ID-2) ربط دراسة سيفالو سابقة بحالة التقويم — باختيار الطبيب الصريح وتأكيده.
 *
 * تُعرض دراسات المريض التي لا حالة لها (مع مرحلتها وتاريخ أشعتها واعتمادها)، ويختار الطبيب الدراسة المقصودة بنفسه
 * ويؤكد الربط. لا أقدم ولا أحدث تلقائيًا، ولا ربط جماعيًا. الحفظ يمرّ بالخادم وحده (لا «تم» قبل إقراره) ويحمل ما
 * عاينه الطبيب ليرفض الخادم السياق القديم. اللوحة جزء من تبويب السجلات القائم لا تبويبٌ جديد.
 */
export interface UnlinkedStudy {
  id: number | string;
  status: "draft" | "completed" | "discarded";
  phase: CephDiagnosticStage;
  xrayDate: string | null;
}

type Pending = { studyId: number; confirmed: boolean; saving: boolean };

export function CephUnlinkedStudiesPanel({
  patientId, orthoCaseId, authority, studies, onLinked,
}: {
  patientId: number;
  orthoCaseId: number;
  /** هوية الجلسة وصلاحياتها: تغيّرها تُسقط أي تأكيد مفتوح. */
  authority: string;
  studies: UnlinkedStudy[];
  onLinked: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // السياق الحالي ورقم العملية: ردٌّ متأخر بعد تبديل المريض/الحالة/الجلسة لا يلمس الشاشة.
  const context = `${patientId}|${orthoCaseId}|${authority}`;
  const contextRef = useRef(context);
  const sequence = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    contextRef.current = context;
    sequence.current += 1;
    busy.current = false;
    setPending(null);
    setMessage(null);
    return () => { sequence.current += 1; busy.current = false; };
  }, [context]);

  if (studies.length === 0 && !message) return null;

  const describe = (study: UnlinkedStudy) => {
    // labelAr يحمل رمز المرحلة أصلًا («قبل العلاج (T1)») فلا يُكرَّر.
    const stage = CEPH_DIAGNOSTIC_STAGES[study.phase];
    return `${stage?.labelAr ?? study.phase} — ${study.xrayDate ? friendlyDateLong(study.xrayDate) : "تاريخ الأشعة غير معروف"} — ${study.status === "completed" ? "معتمدة" : "مسودة"}`;
  };

  const link = async (study: UnlinkedStudy) => {
    const studyId = Number(study.id);
    if (busy.current || !pending || pending.studyId !== studyId || !pending.confirmed) return;
    busy.current = true;
    const mine = ++sequence.current;
    const key = contextRef.current;
    const current = () => sequence.current === mine && contextRef.current === key;
    setPending({ studyId, confirmed: true, saving: true });
    setMessage(null);
    try {
      const response = await fetch(`/api/ceph/${studyId}/link-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orthoCaseId, confirm: true,
          expected: { phase: study.phase, xrayDate: study.xrayDate, status: study.status },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!current()) return;
      if (response.ok && data?.ok === true) {
        setPending(null);
        setMessage({ kind: "ok", text: `تم ربط الدراسة #${studyId} بحالة التقويم #${orthoCaseId}.` });
        onLinked();
      } else {
        const text = typeof data?.message === "string" ? data.message : "تعذّر ربط الدراسة بالحالة. أعد المحاولة.";
        // 409/404: السياق تغيّر (أو لم يعد صالحًا) — يُغلق التأكيد وتُعاد القراءة. غير ذلك: يبقى تأكيد الطبيب مفتوحًا لإعادة المحاولة.
        if (response.status === 409 || response.status === 404) { setPending(null); onLinked(); }
        else setPending({ studyId, confirmed: true, saving: false });
        setMessage({ kind: "error", text });
      }
    } catch {
      if (!current()) return;
      setPending({ studyId, confirmed: true, saving: false });
      setMessage({ kind: "error", text: "تعذّر تأكيد الربط. قد يكون الطلب نُفّذ؛ حدّث الدراسات قبل المحاولة مجددًا." });
    } finally {
      if (sequence.current === mine) busy.current = false;
    }
  };

  return (
    <section aria-labelledby="ceph-unlinked-title" className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-right">
      <h4 id="ceph-unlinked-title" className="text-xs font-extrabold text-sky-900">دراسات سابقة غير مرتبطة بأي حالة</h4>
      <p className="mt-0.5 text-[11px] text-sky-800">
        الربط اختيارك الصريح: لا تُربط دراسة تلقائيًا، ولا يتغير أي قياس أو اعتماد أو تاريخ. اختر الدراسة المقصودة لهذه الحالة (#{orthoCaseId}) ثم أكّد.
      </p>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"}
          className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${message.kind === "error"
            ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {message.text}
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {studies.map((study) => {
          const studyId = Number(study.id);
          const open = pending?.studyId === studyId;
          return (
            <li key={studyId} className="rounded-lg border border-slate-200 bg-white p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-words text-[11px] font-bold text-slate-800">
                  <span className="font-mono">#{studyId}</span> · {describe(study)}
                </p>
                {!open && (
                  <button type="button" disabled={pending?.saving === true}
                    onClick={() => { setMessage(null); setPending({ studyId, confirmed: false, saving: false }); }}
                    className="shrink-0 rounded-lg border border-navy-800 px-3 py-1 text-[11px] font-extrabold text-navy-800 hover:bg-navy-50 disabled:opacity-40">
                    ربط بهذه الحالة
                  </button>
                )}
              </div>
              {open && pending && (
                <div className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                  <p className="text-[11px] text-amber-900">
                    ستُربط هذه الدراسة بحالة التقويم #{orthoCaseId}. لا تتغير قياساتها ولا اعتمادها ولا تاريخها.
                  </p>
                  <label className="flex items-start gap-2 text-[11px] font-bold text-slate-800">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-navy-800" checked={pending.confirmed} disabled={pending.saving}
                      onChange={(event) => setPending({ studyId, confirmed: event.target.checked, saving: false })} />
                    <span>راجعتُ الدراسة وأؤكد أنها المقصودة بهذه الحالة</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={!pending.confirmed || pending.saving} onClick={() => void link(study)}
                      className="rounded-lg bg-navy-800 px-4 py-1.5 text-[11px] font-black text-white hover:bg-navy-900 disabled:opacity-40">
                      {pending.saving ? "جارٍ الربط…" : "تأكيد الربط"}
                    </button>
                    <button type="button" disabled={pending.saving} onClick={() => setPending(null)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 disabled:opacity-40">
                      إلغاء
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
