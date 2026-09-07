import { notFound } from "next/navigation";
import { getCephAnalysisForCompare, getPatient, getSettingsSafe } from "@/lib/db";
import { compareAnalyses, comparisonSummary, chronologicalOrder, CHANGE_LABEL } from "@/lib/cephCompare";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  midtreatment: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

/**
 * تقرير مقارنة تحليلين سيفالومتريين — مطبوع. (من مستودع الوكيل الآخر.)
 *
 * التحليل الواحد يقول **أين المريض من المعيار**، والمقارنة تقول **ماذا فعل
 * العلاج** — وهو السؤال الذي يُسأل في نهاية علاجٍ امتدّ سنتين. والترتيب يُفرض
 * في الخادم: الأقدم «قبل» والأحدث «بعد»، فلا يقلبه من نادى.
 *
 * والحكم معروضٌ بالاقتراب من المعيار لا باتجاه الرقم — ولا تحكم الورقة على
 * العلاج: هي تعدّ القياسات والطبيب يقرأ.
 */
export default async function CephComparePrintPage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string; second?: string }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const params = await searchParams;
  const first = Number(params.first);
  const second = Number(params.second);
  if (!Number.isInteger(first) || first <= 0 || !Number.isInteger(second) || second <= 0
      || first === second) {
    notFound();
  }

  const [one, two] = await Promise.all([
    getCephAnalysisForCompare(first), getCephAnalysisForCompare(second),
  ]);
  if (!one || !two || one.patientId !== two.patientId) notFound();

  const [before, after] = chronologicalOrder(one, two);
  const comparison = compareAnalyses(before.measurements, after.measurements);
  const summary = comparisonSummary(comparison);

  const [patient, settings] = await Promise.all([
    getPatient(before.patientId), getSettingsSafe(),
  ]);

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="تقرير مقارنة التحليلات السيفالومترية" />

        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 800 }}>{patient?.fullName ?? `#${before.patientId}`}</span>
        </div>
        <div className="line">
          <span>رقم الملف</span>
          <span className="num" dir="ltr">{patient?.patientNumber ?? "—"}</span>
        </div>
        <div className="line">
          <span>المقارنة</span>
          <span>
            #{before.id} ({PHASE_LABEL[before.phase] ?? before.phase} —{" "}
            {before.xrayDate ? friendlyDateLong(before.xrayDate) : "بلا تاريخ تصوير"})
            {" ← "}
            #{after.id} ({PHASE_LABEL[after.phase] ?? after.phase} —{" "}
            {after.xrayDate ? friendlyDateLong(after.xrayDate) : "بلا تاريخ تصوير"})
          </span>
        </div>

        <div className="rule-light" />
        <p style={{ fontWeight: 800, margin: "2mm 0" }}>{summary.ar}</p>

        {comparison.measurements.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "9pt" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #999" }}>
                <th style={{ padding: "1.5mm", textAlign: "right" }}>القياس</th>
                <th style={{ padding: "1.5mm" }}>قبل</th>
                <th style={{ padding: "1.5mm" }}>بعد</th>
                <th style={{ padding: "1.5mm" }}>الفرق</th>
                <th style={{ padding: "1.5mm" }}>الحكم</th>
              </tr>
            </thead>
            <tbody>
              {comparison.measurements.map((row) => (
                <tr key={row.key} style={{ borderBottom: "1px solid #ddd" }}>
                  <td style={{ padding: "1.5mm", textAlign: "right", fontWeight: 700 }}>
                    {row.name} <span style={{ fontSize: "7pt", opacity: 0.6 }}>({row.unit})</span>
                  </td>
                  <td style={{ padding: "1.5mm", textAlign: "center" }}>{row.before.toFixed(1)}</td>
                  <td style={{ padding: "1.5mm", textAlign: "center", fontWeight: 800 }}>{row.after.toFixed(1)}</td>
                  <td style={{ padding: "1.5mm", textAlign: "center", fontWeight: 800 }}>
                    {row.delta > 0 ? "+" : ""}{row.delta.toFixed(1)}
                  </td>
                  <td style={{ padding: "1.5mm", textAlign: "center", fontSize: "8pt" }}>
                    {CHANGE_LABEL[row.direction].ar}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ fontWeight: 700, fontSize: "9pt" }}>
            لا قياسًا مشتركًا بين التحليلين — لا يُقارَنان.
          </p>
        )}

        <p style={{ fontSize: "8pt", opacity: 0.75, marginTop: "3mm" }}>
          «تحسّن» و«تراجع» هنا يعنيان الاقتراب من المعيار وابتعداه — لا اتجاه الرقم.
          وقياسٌ في تحليلٍ واحد لا يُعرض فرقًا: غياب النقطة ليس ثباتًا. والحكم على
          العلاج للطبيب المعالج.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
