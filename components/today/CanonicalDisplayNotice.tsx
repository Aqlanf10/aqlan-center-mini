"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
interface Notice { on: boolean; version: string | null; canEdit: boolean }
/** Staff controls are admitted separately from the anonymous public screen. */
export function CanonicalDisplayNotice() {
  const session = useSession();
  const mayRead = session?.canonical === true && (session.isOwner === true || session.capabilities?.includes("settings.view") === true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const response = await fetch("/api/display/notice", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("notice unavailable");
      const next = await response.json() as Notice;
      if (sequence.current === current) setNotice(next);
    } catch { if (sequence.current === current) setNotice(null); }
  }, []);
  useEffect(() => {
    if (!mayRead) { setNotice(null); return; }
    void reload(); const timer = setInterval(() => { void reload(); }, 20_000);
    const visible = () => { if (document.visibilityState === "visible") void reload(); else { sequence.current++; setNotice(null); } };
    window.addEventListener("focus", reload); document.addEventListener("visibilitychange", visible);
    // A request generation counter, not a DOM node: invalidate every in-flight reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; clearInterval(timer); window.removeEventListener("focus", reload); document.removeEventListener("visibilitychange", visible); };
  }, [mayRead, reload]);
  async function toggle() {
    if (!notice?.canEdit || busy) return;
    setBusy(true); setMessage(""); sequence.current++;
    try {
      const response = await fetch("/api/display/notice", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !notice.on, version: notice.version }), signal: AbortSignal.timeout(8_000) });
      if (!response.ok) { setNotice(null); setMessage(response.status === 409 ? "تغيّرت الرسالة؛ راجع الحالة الحالية ثم اختر من جديد." : "تعذّر تغيير الرسالة؛ تحقق من صلاحيتك والحالة الحالية."); }
      else setMessage("حُفظت رسالة شاشة الصالة.");
    } catch { setNotice(null); setMessage("لم يتأكد الحفظ؛ نحدّث الحالة قبل أي محاولة جديدة."); }
    finally { await reload(); setBusy(false); }
  }
  return <div data-testid="canonical-display-controls" className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <a href="/display" target="_blank" rel="noopener noreferrer" className="font-bold text-brand-blue">فتح شاشة الصالة العامة</a>
    {mayRead && notice ? <><span>رسالة التأخير: {notice.on ? "مفعّلة" : "متوقفة"}</span>{notice.canEdit ? <button disabled={busy} onClick={() => void toggle()} className="rounded-lg border border-slate-300 px-3 py-1.5 font-bold disabled:opacity-50">{notice.on ? "إيقاف رسالة التأخير" : "تشغيل رسالة التأخير"}</button> : null}</> : null}
    {message ? <span role="status">{message}</span> : null}
  </div>;
}
