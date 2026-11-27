import { notFound } from "next/navigation";
import { PrintButton } from "@/components/PrintButton";
import { PrintableReportDocument } from "@/components/reports/PrintableReportDocument";
import { canAccessUnifiedReport, isDisbursementReport } from "@/lib/report-access";
import { buildReport, dbTodayISO, parseFilters, ReportInputError, validateCustomReportRange } from "@/lib/reports";
import { CLINIC_TIME_ZONE, getSettingsSafe } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { parseReportView } from "@/lib/report-view";

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

  const search = await searchParams;
  const params = toParams(search);
  const report = params.get("report") ?? "daily";
  if (!canAccessUnifiedReport(session.role, report, session.financeAccess) || report === "options") notFound();

  let settings: Awaited<ReturnType<typeof getSettingsSafe>>;
  let result: Awaited<ReturnType<typeof buildReport>>;
  try {
    if (isDisbursementReport(report)) {
      for (const key of ["report", "currency", "preset", "from", "to", "expenseRecipient", "expenseCategory"]) {
        const values = search[key];
        if (Array.isArray(values) && values.length > 1) notFound();
      }
    }
    if (report === "debt" || isDisbursementReport(report)) validateCustomReportRange(params);
    const [today, printSettings] = await Promise.all([dbTodayISO(), getSettingsSafe()]);
    settings = printSettings;
    const filters = parseFilters(params, today);
    result = await buildReport(report, filters);
  } catch (error) {
    if (error instanceof ReportInputError) notFound();
    throw error;
  }

  // (Reports R3) عرض المستخدم نفسه (الأعمدة وترتيبها، الترتيب، التجميع) — طبقة عرضٍ لا حساب.
  const view = parseReportView(params);

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
        view={view}
      />
    </>
  );
}
