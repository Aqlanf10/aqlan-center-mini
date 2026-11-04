"use client";

import Link from "next/link";
import { useLayoutEffect, useState } from "react";
import { useSessionActions } from "@/components/SessionProvider";
import { RadiologyCentersEditor } from "@/components/settings/RadiologyCentersEditor";
import { canManageCategory, roleCan } from "@/lib/settings-permissions";
import { RADIOLOGY_CENTERS_KEY as KEY } from "@/lib/radiology-centers";

export default function RadiologySettingsPage() {
  const { session, ready } = useSessionActions();
  return <RadiologySettingsOwner key={JSON.stringify([ready,session?.username??null,session?.role??null])} role={session?.role??null} ready={ready}/>;
}
function RadiologySettingsOwner({role,ready}:{role:string|null;ready:boolean}) {
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const allowed = ready && roleCan(role, "settings.view");
  useLayoutEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal, cache: "no-store" }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || "تعذّر تحميل مراكز الأشعة.");
      if (!data || typeof data[KEY] !== "string" || !data.__versions || !(KEY in data.__versions)) throw new Error("استجابة الإعدادات غير مكتملة.");
      if (!controller.signal.aborted) { setSnapshot(data); setError(null); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "تعذّر التحميل."); });
    return () => controller.abort();
  }, [allowed, attempt]);
  return <main dir="rtl" className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
    <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-blue-700">العودة إلى الإعدادات</Link>
    <h1 className="text-2xl font-black text-navy-950">إعدادات مراكز الأشعة</h1>
    {!allowed ? <p role="alert">عرض الإعدادات غير مسموح لهذا الدور.</p> : error ? <div role="alert"><p>{error}</p><button type="button" className="mt-3 min-h-11 rounded-xl border px-4" onClick={() => { setError(null); setAttempt(value => value + 1); }}>إعادة المحاولة</button></div> : !snapshot ? <p role="status">جارٍ تحميل المراكز…</p> :
      <RadiologyCentersEditor values={{ [KEY]: snapshot[KEY] as string }} versions={snapshot.__versions as Record<string, string | null>} editable={canManageCategory(role, "clinical")} onSaved={setSnapshot} />}
  </main>;
}
