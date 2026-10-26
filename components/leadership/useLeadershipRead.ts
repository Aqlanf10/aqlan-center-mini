"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";

export const LeadershipReadAccessContext = createContext<(() => void) | null>(null);

/** Read-only, principal-owned transport. No retries, cache or polling; new scope clears old data synchronously. */
export function useLeadershipRead<T>(url: string | null, decode: (value: unknown) => T | null) {
  const onForbidden = useContext(LeadershipReadAccessContext);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ key: string; value: T | null; error: string | null; receivedAt: string | null }>({ key: "", value: null, error: null, receivedAt: null });
  const [stale, setStale] = useState(false);
  const sequence = useRef(0), decodeRef = useRef(decode);
  decodeRef.current = decode;
  const key = JSON.stringify([url, revision]);
  const current = read.key === key;
  useEffect(() => {
    if (url === null) return;
    const request = ++sequence.current, controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if ((response.status === 401 || response.status === 403) && request === sequence.current && !controller.signal.aborted) onForbidden?.();
        if (!response.ok) throw new Error(response.status === 409
          ? "تحتاج بيانات المصدر إلى مراجعة سلامة السجلات. لا تُعرض قيم حتى تُحل المراجعة في المصدر."
          : response.status === 401 || response.status === 403
          ? "انتهت الجلسة أو تغيّرت الصلاحية. سجّل الدخول من جديد."
          : "تعذّر التحقق من المصدر. العدد غير معروف؛ أعد المحاولة.");
        const value = decodeRef.current(await response.json());
        if (!value) throw new Error("تعذّر التحقق من بيانات المصدر. العدد غير معروف.");
        if (request === sequence.current && !controller.signal.aborted) {
          setStale(false); setRead({ key, value, error: null, receivedAt: new Date().toISOString() });
        }
      } catch (failure) {
        if (request !== sequence.current || controller.signal.aborted && !timedOut) return;
        setRead({ key, value: null, receivedAt: null, error: timedOut ? "استغرقت القراءة وقتًا طويلًا. العدد غير معروف؛ أعد المحاولة."
          : failure instanceof Error ? failure.message : "تعذّر التحقق من المصدر." });
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [url, key, onForbidden]);
  useEffect(() => {
    const mark = () => setStale(true), visible = () => { if (document.visibilityState === "visible") mark(); };
    window.addEventListener("focus", mark); window.addEventListener("online", mark); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", mark); window.removeEventListener("online", mark); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return { data: url !== null && current ? read.value : null, error: url !== null && current ? read.error : null,
    loading: url !== null && (!current || !read.value && !read.error), stale: url !== null && current && stale, receivedAt: url !== null && current ? read.receivedAt : null,
    refresh: () => { setStale(false); setRevision(n => n + 1); } };
}
