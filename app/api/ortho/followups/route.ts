import {readAuthorizedOrthoFollowupBoard, OrthoFollowupAuthorityError} from '@/lib/ortho-followup-authority';
import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
} from "@/lib/db";
import { classifyFollowups, groupByBucket, BUCKET_ORDER } from "@/lib/ortho-followup";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

/**
 * مركز متابعة التقويم.
 *
 * قائمة يومية للاستقبال والطبيب معًا: كل حالةٍ تقويمٍ جارية في قوائمها — اليوم،
 * غدًا، هذا الأسبوع، بدون موعد قادم، تجاوزوا موعدهم، لم يحضروا، والمتأخرات
 * بالأسابيع، وحالات التثبيت. التصنيف نفسه في `lib/ortho-followup.ts` الخالصة،
 * وهنا القاعدةُ والجلسة وحسب.
 *
 * عزل الطبيب (§٣٩): الطبيب يرى حالات مرضاه وحدهم ما لم يمنحه المدير «عرض جميع
 * المرضى» — والفلترة في الخادم لا في الشاشة، والاستقبال والإدارة يريان الكل.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  }
  // Mirror the existing proxy boundary without granting assistants or finance
  // roles a clinic-wide clinical board when the handler is invoked directly.
  if (!["admin", "reception", "doctor"].includes(session.role)) {
    return json({ message: "غير مصرّح لك بالاطلاع على لوحة متابعة التقويم." }, 403);
  }
  const asOf = new Date();
  const today = clinicDateString(asOf, CLINIC_TIME_ZONE);
  try {
    const board = await readAuthorizedOrthoFollowupBoard(session, today, asOf);

    const rows = classifyFollowups({ cases: board, today });
    const groups = groupByBucket(rows);
    const buckets = BUCKET_ORDER.map((bucket) => ({
      bucket,
      count: groups.get(bucket)?.length ?? 0,
      rows: groups.get(bucket) ?? [],
    }));
    return json({ today, buckets });
  } catch (error) {
    if (error instanceof OrthoFollowupAuthorityError) return json({message:error.message},error.status);
    return json({ message: "تعذّر تحميل لوحة متابعة التقويم." }, 500);
  }
}
