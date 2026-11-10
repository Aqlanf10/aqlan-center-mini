import { isolateStudyDateTokens } from "@/lib/ortho-study-display";
import FullStudyPrint from "@/components/OrthoFullStudyPrint";
import IllustratedStudyPrint from "@/components/OrthoIllustratedStudyPrint";
import { PrintHeader } from "@/components/PrintHeader";
import { getSettingsSafe } from "@/lib/db";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { routeId } from "@/lib/ortho-journey-route";
import { getOrthoCaseStudy } from "@/lib/ortho-case-study-store";
import { studyTextPresentation } from "@/lib/ortho-study-text-export";
import { OrthoStudyPrintButton } from "@/components/OrthoStudyPrintButton";
export const dynamic = "force-dynamic";
export default async function OrthoStudyPrint({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(), query = await searchParams;
  const orthoCaseId = routeId((await params).id), patientId = routeId(query.patientId), revisionId = routeId(query.revisionId);
  if (!session || !orthoCaseId || !patientId || !revisionId || Object.keys(query).some(key => key !== "patientId" && key !== "revisionId" && key !== "mode") || query.mode !== undefined && query.mode !== "illustrated" && query.mode !== "full") notFound();
  if (query.mode === "full") return <FullStudyPrint session={session} orthoCaseId={orthoCaseId} patientId={patientId} revisionId={revisionId} />;
  if (query.mode === "illustrated") return <IllustratedStudyPrint session={session} orthoCaseId={orthoCaseId} patientId={patientId} revisionId={revisionId} />;
  const result = await getOrthoCaseStudy({ session, patientId, orthoCaseId, revisionId, exportAccess: true });
  if (!result.ok || !result.revision) notFound();
  const value = studyTextPresentation(result.revision, result);
  const settings = await getSettingsSafe();
  // Clinic header preparation must not bypass current authority on released facts.
  const fresh = await getOrthoCaseStudy({ session, patientId, orthoCaseId, revisionId, exportAccess: true });
  if (!fresh.ok || fresh.revision?.id !== revisionId || fresh.revision.contentHash !== value.revisionHash) notFound();
  return <main dir="rtl" className="mx-auto max-w-5xl space-y-5 bg-white p-5 text-slate-900">
    <div className="print:hidden space-y-2"><h1 className="text-xl font-bold">عرض الحالة — نسخة نصية</h1><p>تُطبع النسخة المحفوظة المختارة. هذه نسخة سريرية داخل الملف، ولا تشمل الصور أو إخفاء الهوية للنشر التعليمي.</p><OrthoStudyPrintButton /></div>
    {value.pages.map((page, index) => <section key={index} className="break-after-page last:break-after-auto border p-6 print:border-0">
      <PrintHeader settings={settings} title={page.title} />
      <p className="my-3 text-sm">الحالة {value.caseId} · الإصدار {value.version} · {value.kind === "draft" ? "مسودة" : "نسخة موثقة"} · نسخة نصية</p>
      <div className="space-y-2">{page.lines.map((line, n) => <p key={n} className="whitespace-pre-wrap break-words" dir="auto">{isolateStudyDateTokens(line) || "\u00a0"}</p>)}</div>
      <footer className="mt-5 border-t pt-2 text-xs text-slate-600"><p><bdi dir="ltr">{index + 1} / {value.pages.length}</bdi> · محفوظة في <bdi dir="ltr" data-study-captured-at>{value.capturedAt}</bdi></p><p dir="ltr" className="break-all">SHA256: {value.revisionHash}</p><p>المراجع: {page.sourceKeys.join("، ") || "لا توجد مراجع مختارة"}</p></footer>
    </section>)}
  </main>;
}
