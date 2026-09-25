import { notFound } from "next/navigation";
import { PrintButton } from "@/components/PrintButton";
import { PrintableReportDocument } from "@/components/reports/PrintableReportDocument";
import { canAccessUnifiedReport } from "@/lib/report-access";
import { buildReport, dbTodayISO, parseFilters, ReportInputError } from "@/lib/reports";
import { CLINIC_TIME_ZONE, getSettingsSafe } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

function toParams(source: Record<string, SearchValue>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value.length > 0) params.set(key, value[0]);
  }
  return params;
}

export default async function OfficialReportPrintPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const params = toParams(await searchParams);
  const report = params.get("report") ?? "daily";
  if (!canAccessUnifiedReport(session.role, report) || report === "options") notFound();

  try {
    const [today, settings] = await Promise.all([dbTodayISO(), getSettingsSafe()]);
    const filters = parseFilters(params, today);
    const result = await buildReport(report, filters);
    const generatedAt = new Intl.DateTimeFormat("ar-YE", {
      timeZone: CLINIC_TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());

    return (
      <>
        <PrintButton />
        <PrintableReportDocument
          result={result}
          settings={settings}
          generatedAt={generatedAt}
          generatedBy={session.username}
        />
      </>
    );
  } catch (error) {
    if (error instanceof ReportInputError) notFound();
    throw error;
  }
}
