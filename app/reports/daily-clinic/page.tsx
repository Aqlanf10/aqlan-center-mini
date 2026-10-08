import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { getDailyClinicReportToday } from "@/lib/daily-clinic-report";
import { DailyClinicReportView } from "./DailyClinicReportView";

export const dynamic = "force-dynamic";

export default async function DailyClinicReportPage({ searchParams }: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const session = await requireSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") notFound();

  const params = await searchParams;
  const today = getDailyClinicReportToday();
  // Invalid or repeated dates stay invalid; they must not silently become today.
  const initialDate = Array.isArray(params.date) ? "" : params.date ?? today;
  return <DailyClinicReportView initialDate={initialDate} clinicTimeZone={CLINIC_TIME_ZONE} />;
}
