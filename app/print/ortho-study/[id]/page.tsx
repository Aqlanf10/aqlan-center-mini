import { PrintHeader } from "@/components/PrintHeader";
import { getSettingsSafe } from "@/lib/db";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { routeId } from "@/lib/ortho-journey-route";
import { getOrthoCaseStudy } from "@/lib/ortho-case-study-store";
import { studyTextPresentation } from "@/lib/ortho-study-text-export";
import { OrthoStudyPrintButton } from "@/components/OrthoStudyPrintButton";
import IllustratedStudyPrint from "@/components/OrthoIllustratedStudyPrint";
export const dynamic = "force-dynamic";
export default async function OrthoStudyPrint({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(), query = await searchParams;
  const orthoCaseId = routeId((await params).id), patientId = routeId(query.patientId), revisionId = routeId(query.revisionId);
  if (!session || !orthoCaseId || !patientId || !revisionId) notFound();
  if (query.mode === "illustrated") return <IllustratedStudyPrint session={session} orthoCaseId={orthoCaseId} patientId={patientId} revisionId={revisionId} />;
  const result = await getOrthoCaseStudy({ session, patientId, orthoCaseId, revisionId });
  if (!result.ok || !result.revision) notFound();
  const value = studyTextPresentation(result.revision, result);
  const settings = await getSettingsSafe();
  return <main dir="rtl" className="mx-auto max-w-5xl space-y-5 bg-white p-5 text-slate-900">
    <div className="print:hidden space-y-2"><h1 className="text-xl font-bold">عرض الحالة — نسخة نصية</h1><p>تُطبع النسخة المحفوظة المختارة. هذه نسخة سريرية داخل الملف، ولا تشمل الصور أو إخفاء الهوية للنشر التعليمي.</p><OrthoStudyPrintButton /></div>
    {value.pages.map((page, index) => <section key={index} className="break-after-page border p-6 print:border-0">
      <PrintHeader settings={settings} title={page.title} compact strictIdentity />
      <p className="my-3 text-sm">الحالة {value.caseId} · الإصدار {value.version} · {value.kind === "draft" ? "مسودة" : "نسخة موثقة"} · نسخة نصية</p>
      <div className="space-y-2">{page.lines.map((line, n) => <p key={n} className="whitespace-pre-wrap break-words" dir="auto">{line || "\u00a0"}</p>)}</div>
      <footer className="mt-5 border-t pt-2 text-xs text-slate-600"><p>{index + 1} / {value.pages.length} · محفوظة في {value.capturedAt}</p><p dir="ltr" className="break-all">SHA256: {value.revisionHash}</p><p>المراجع: {page.sourceKeys.join("، ") || "لا توجد مراجع مختارة"}</p></footer>
    </section>)}
  </main>;
}
