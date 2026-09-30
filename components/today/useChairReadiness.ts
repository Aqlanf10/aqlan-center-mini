"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReadinessItem } from "@/lib/chair-readiness";

/** صفّ جاهزية زيارةٍ كما يعيده `GET /api/visits/readiness`. */
export interface VisitReadiness {
  visitId: number;
  patientId: number | null;
  status: string;
  chair: number | null;
  arrivedAt: string;
  seatedAt: string | null;
  signedAt: string | null;
  cleared: { at: string; by: string | null } | null;
  /** null = الملف ليس لهذا الطبيب — تُعرض الشارة بلا تفاصيل. */
  checklist: ReadinessItem[] | null;
  attention: number | null;
  alerts: string[] | null;
}

/**
 * (CHAIR-1) جاهزية زيارات اليوم للوحة — طلبٌ مستقلّ عن `/api/visits` عمدًا: شاشة الصالة تقرأ
 * ذاك المسار، والتنبيهات الطبية لا تذهب إليها. فشل التحميل يُبقي آخر قراءةٍ صحيحة
 * ولا يعطّل اللوحة: الشارة مساعدةٌ لا شرط.
 */
export function useChairReadiness(refreshMs: number) {
  const [byVisit, setByVisit] = useState<Map<number, VisitReadiness>>(new Map());

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/visits/readiness", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { items?: VisitReadiness[] };
      if (!Array.isArray(payload.items)) return;
      setByVisit(new Map(payload.items.map((item) => [item.visitId, item])));
    } catch { /* آخر قراءةٍ تبقى */ }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => { void reload(); }, 0);
    const poll = setInterval(() => { void reload(); }, refreshMs);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [reload, refreshMs]);

  return { byVisit, reload };
}

