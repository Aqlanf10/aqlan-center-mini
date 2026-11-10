"use client";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

const sections = [
  ["records", "السجلات والصور"],
  ["ceph", "السيفالومتري"],
  ["comparison", "مقارنة الصور"],
  ["assessment", "التشخيص والتقييم والقياسات"],
] as const;

/** Focus/scroll only. Children stay mounted, visible and in their original order. */
export function OrthoDiagnosticNavigation({ ownerIdentity, orthoCaseId, readVersion, active, children, navigationVisible = true }: {
  ownerIdentity: object; orthoCaseId: number; readVersion: number; active: () => boolean; children: ReactNode; navigationVisible?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const token = useMemo(() => ({ ownerIdentity, orthoCaseId, readVersion, active, navigationVisible }), [ownerIdentity, orthoCaseId, readVersion, active, navigationVisible]);
  const committed = useRef<typeof token | null>(null);
  useLayoutEffect(() => { committed.current = token; return () => { if (committed.current === token) committed.current = null; }; }, [token]);
  const jump = (section: typeof sections[number][0]) => {
    const container = root.current;
    if (committed.current !== token || !active() || !container?.isConnected) return;
    const target = container.querySelector<HTMLElement>(`[data-ortho-diagnostic-section="${section}"]`);
    if (!target?.isConnected || !container.contains(target)) return;
    target.focus({ preventScroll: true });
    if (committed.current === token && active() && root.current === container && target.isConnected && container.contains(target)) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };
  return <div ref={root} className="space-y-4" data-testid="ortho-diagnostic-navigation">
    <nav hidden={!navigationVisible} aria-label="الانتقال بين أقسام التشخيص" className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs text-slate-600">انتقال داخل الصفحة فقط؛ لا يحفظ التعديلات ولا يغيّر حالة التقييم.</p>
      <div className="flex flex-wrap gap-2">{sections.map(([key, label]) => <button key={key} type="button"
        className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => jump(key)}>{label}</button>)}</div>
    </nav>
    {children}
  </div>;
}
