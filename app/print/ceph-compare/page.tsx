import { PrintMetadata, PrintTableFrame } from "@/components/PrintDocument";
import { notFound } from "next/navigation";
import { getCephAnalysisForCompare, getPatient, getSettingsSafe } from "@/lib/db";
import { compareAnalyses, comparisonSummary, resolveCephComparisonOrder, parseCephComparisonQuery, cephOrderLabels, isCephAcquisitionDate, CEPH_ORDER_REQUIRED_NOTICE, CHANGE_LABEL } from "@/lib/cephCompare";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  midtreatment: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

/** Uses the same acquisition/reference contract as the interactive comparison. */
export default async function CephComparePrintPage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string | string[]; second?: string | string[]; reference?: string | string[] }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const params = await searchParams;
  const query = parseCephComparisonQuery(params);
  if (!query) notFound();
  const { first, second, referenceId } = query;

  const [one, two] = await Promise.all([
    getCephAnalysisForCompare(first), getCephAnalysisForCompare(second),
  ]);
  if (!one || !two || one.patientId !== two.patientId) notFound();
  /* حرس الباب (P0.12): صفحة الطباعة تتحقق بنفسها من ملكية المريض — لا
   * تعتمد على الوكيل العام الذي يمرر /print/*. */
  if (!(await canAccessPatient(session, one.patientId, "canViewXrays").catch(() => false))) notFound();


  const order = resolveCephComparisonOrder(one, two, referenceId);
  if (order.state === "invalid") notFound();
  const unavailable = one.comparisonUnavailableReason ?? two.comparisonUnavailableReason;
  const [patient, settings] = await Promise.all([getPatient(one.patientId), getSettingsSafe()]);
  if (order.state !== "resolved" || unavailable) return <>
    <PrintButton /><div className="sheet sheet-a4">
      <PrintHeader settings={settings} title="تقرير مقارنة التحليلات السيفالومترية" />
      <PrintMetadata><p>{patient?.fullName ?? `#${one.patientId}`}</p><p>التحليلان: #{first}، #{second}</p></PrintMetadata>
      <p role="alert">{unavailable ?? CEPH_ORDER_REQUIRED_NOTICE}</p>
      {!unavailable && <a href={`/ceph/compare?first=${first}&second=${second}`}>فتح المقارنة لاختيار المرجع صراحةً</a>}
      <PrintFooter settings={settings} />
    </div>
  </>;
  const { before, after, ordering } = order;
  const labels = cephOrderLabels(ordering), explicit = ordering.mode === "explicit_reference";
  const comparison = compareAnalyses(before.measurements, after.measurements);
  const summary = comparisonSummary(comparison);

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="تقرير مقارنة التحليلات السيفالومترية" />

        <PrintMetadata><div className="line">
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
            {labels.before}: #{before.id} ({!explicit && <>المرحلة المسجلة: {Object.hasOwn(PHASE_LABEL, before.phase) ? PHASE_LABEL[before.phase] : before.phase} — </>}
            {isCephAcquisitionDate(before.xrayDate) ? friendlyDateLong(before.xrayDate) : "بلا تاريخ تصوير صالح"})
            {" ← "}
            {labels.after}: #{after.id} ({!explicit && <>المرحلة المسجلة: {Object.hasOwn(PHASE_LABEL, after.phase) ? PHASE_LABEL[after.phase] : after.phase} — </>}
            {isCephAcquisitionDate(after.xrayDate) ? friendlyDateLong(after.xrayDate) : "بلا تاريخ تصوير صالح"})
          </span>
        </div></PrintMetadata>

        <div className="rule-light" />
        <p style={{ fontWeight: 800, margin: "2mm 0" }}>{labels.notice} {summary.ar}</p>
        {[...new Set([before.provenanceNotice, after.provenanceNotice].filter(Boolean))].map(notice => <p key={notice} style={{ fontSize: "8pt" }}>{notice}</p>)}

        {comparison.measurements.length > 0 ? (
          <PrintTableFrame><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "9pt" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #999" }}>
                <th style={{ padding: "1.5mm", textAlign: "right" }}>القياس</th>
                <th style={{ padding: "1.5mm" }}>{labels.before}</th>
                <th style={{ padding: "1.5mm" }}>{labels.after}</th>
                <th style={{ padding: "1.5mm" }}>الفرق</th>
                <th style={{ padding: "1.5mm" }}>الوصف</th>
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
                    {explicit ? "فرق وصفي؛ التسلسل الزمني غير معروف" : CHANGE_LABEL.ungraded.ar}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></PrintTableFrame>
        ) : (
          <p style={{ fontWeight: 700, fontSize: "9pt" }}>
            لا قياسًا مشتركًا متوافقَ المصدر والوحدة بين التحليلين — لا يُقارَنان.
          </p>
        )}

        <p style={{ fontSize: "8pt", opacity: 0.75, marginTop: "3mm" }}>
          الفروق وصفية وتتأثر بدقة المعالم والمعايرة. قياسٌ في تحليلٍ واحد لا يُعرض فرقًا؛ غياب النقطة ليس ثباتًا. لا يثبت هذا التقرير أثر العلاج.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
