import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, doctorOwnedPatientIds, findUserByUsername, orthoFollowupBoard,
} from "@/lib/db";
import { classifyFollowups, groupByBucket, BUCKET_ORDER } from "@/lib/ortho-followup";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

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
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  try {
    let board = await orthoFollowupBoard(today);

    if (session.role === "doctor" && typeof session.partyId === "number" && session.partyId) {
      const user = await findUserByUsername(session.username).catch(() => null);
      if (!user?.permissions?.canViewAllPatients) {
        const candidateIds = Array.from(new Set(board.map((row) => row.patientId)));
        const owned = await doctorOwnedPatientIds(session.partyId, candidateIds)
          .catch(() => new Set<number>());
        board = board.filter((row) => owned.has(row.patientId));
      }
    }

    const rows = classifyFollowups({ cases: board, today });
    const groups = groupByBucket(rows);
    const buckets = BUCKET_ORDER.map((bucket) => ({
      bucket,
      count: groups.get(bucket)?.length ?? 0,
      rows: groups.get(bucket) ?? [],
    }));
    return NextResponse.json({ today, buckets });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل لوحة متابعة التقويم." }, { status: 500 });
  }
}
