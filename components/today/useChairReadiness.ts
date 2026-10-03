"use client";

import { useCallback, useEffect, useState } from "react";
import type { BalanceLine, ReadinessItem } from "@/lib/chair-readiness";

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
  /** Same visibility as alerts; optional while an older server is still serving. */
  historyAlerts?: string[] | null;
  /** Explicit editable source; same visibility, separate from history warnings. */
  editableAlert?: string | null;
  /** null = لا يرى المال (الطبيب بلا «مدفوعات مرضاي»). */
  balances: BalanceLine[] | null;
}

/**
 * (CHAIR-1) جاهزية زيارات اليوم للوحة — طلبٌ مستقلّ عن `/api/visits` عمدًا: شاشة الصالة تقرأ
 * ذاك المسار، والتنبيهات الطبية والأرصدة لا تذهب إليها. فشل التحميل يُبقي آخر قراءةٍ صحيحة
 * ولا يعطّل اللوحة: الشارة مساعدةٌ لا شرط.
 */
export function useChairReadiness(refreshMs: number) {
  const [byVisit, setByVisit] = useState<Map<number, VisitReadiness>>(new Map());
  const [requireClearance, setRequireClearance] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/visits/readiness", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { items?: VisitReadiness[]; requireClearance?: boolean };
      if (!Array.isArray(payload.items)) return;
      setByVisit(new Map(payload.items.map((item) => [item.visitId, item])));
      setRequireClearance(payload.requireClearance === true);
    } catch { /* آخر قراءةٍ تبقى */ }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => { void reload(); }, 0);
    const poll = setInterval(() => { void reload(); }, refreshMs);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [reload, refreshMs]);

  return { byVisit, requireClearance, reload };
}

/**
 * (CHAIR-1 Slice 3) نداءٌ/إدخالٌ عبر بوابة الجاهزية.
 *
 * الإعداد مغلق (الافتراضي) ⇒ الطلب الأول يمرّ دائمًا ويعود بتحذيرٍ نصّي إن لزم — صفر نقرات.
 * الإعداد مفعَّل والمريض غير مُقَرّ ⇒ 409 برمز البوابة، فيُسأل عن سبب الطوارئ: كتابته تعيد الطلب
 * بسببٍ يُدقَّق، وإلغاؤه يعيد الرفض نفسه (فيُقرّ الجاهزية أولًا).
 */
export async function sendGatedMove(
  visitId: number,
  body: { action: "call" | "seat"; chair: number },
  askEmergencyReason: (message: string) => string | null = (message) =>
    window.prompt(`${message}\n\nللدخول كطوارئ اكتب السبب:`, ""),
): Promise<Response> {
  const send = (extra: Record<string, unknown> = {}) => fetch(`/api/visits/${visitId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...extra }),
  });
  const first = await send();
  if (first.status !== 409) return first;
  const payload = await first.clone().json().catch(() => null) as { code?: string; message?: string } | null;
  if (payload?.code !== "clearance_required" && payload?.code !== "emergency_reason_required") return first;
  const reason = askEmergencyReason(payload.message ?? "");
  if (!reason || !reason.trim()) return first;
  return send({ emergency: true, emergencyReason: reason.trim() });
}
