import { CephSavedCompletionEvidence } from "@/components/CephSavedCompletionEvidence";
import { cephDraftReferenceContext, CEPH_UNAVAILABLE_NOTICE, CEPH_INTEGRITY_NOTICE, cephCompletionNotice, enrichPresentedCephMeasurements, isQuarantinedCephMeasurement, presentCephMeasurements } from "@/lib/cephPresentation";
import { PrintMetadata, PrintTableFrame } from "@/components/PrintDocument";
import { CephDraftReferenceEvidence } from "@/components/CephDraftReferenceEvidence";
import { CephScientificContext } from "@/components/CephScientificContext";
import { notFound } from "next/navigation";
import {
  getCephStudy, getPatient, getSettingsSafe,
} from "@/lib/db";
import {
  computeAll, isDescriptiveCephMeasurement, projectOnLine,
  type LandmarkCode, type LandmarkMap,
} from "@/lib/ceph";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { friendlyDateLong } from "@/lib/reminders";

export const dynamic = "force-dynamic";

/**
 * تقرير التحليل السيفالومتري الرسمي المطبوع — ورقة A4 احترافية ثنائية اللغة.
 *
 * يشمل:
 * 1. ترويسة المركز الرسمية ومعلومات العيادة.
 * 2. بيانات المريض وتفاصيل الفحص وتاريخ الشععة والمقياس المعاير.
 * 3. المخطط الهندسي السيفالومتري للخطوط والمعالم وخط ريكتس (Cephalometric Tracing).
 * 4. جدول القياسات الكامل موزّعاً حسب المجموعات (سهمي، عمودي، أسنان، أنسجة رخوة).
 * 5. خلاصة التشخيص المعتمد وتوصيات خطة العلاج وتوقيع الطبيب المعتمد.
 */

const PHASE_LABEL: Record<string, { ar: string; en: string }> = {
  pretreatment: { ar: "قبل العلاج", en: "Pre-treatment" },
  during: { ar: "أثناء العلاج", en: "In-treatment" },
  posttreatment: { ar: "بعد العلاج", en: "Post-treatment" },
  followup: { ar: "متابعة", en: "Follow-up" },
};

export default async function CephPrintReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [study, settings] = await Promise.all([
    getCephStudy(id),
    getSettingsSafe(),
  ]);

  if (!study) notFound();
  /* حرس الباب (P0.12): صفحة الطباعة تتحقق بنفسها من ملكية المريض — لا
   * تعتمد على الوكيل العام الذي يمرر /print/*. */
  if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays").catch(() => false))) notFound();


  const completed = study.analysis.status === "completed";
  if (completed && study.provenance?.state === "integrity_unavailable") {
    return <p role="alert" className="p-6 text-red-700">{CEPH_INTEGRITY_NOTICE}</p>;
  }
  const historical = completed && study.provenance?.state === "versioned" ? study.provenance.witness : null;
  const diagnosis = historical ? historical.snapshot.diagnosis : study.diagnosis;
  const patient = await getPatient(study.analysis.patientId);
  const draftReference = cephDraftReferenceContext(completed ? undefined : study.completionSources, study.analysis);

  const points: LandmarkMap = {};
  for (const lm of study.landmarks) {
    points[lm.code] = { x: lm.x, y: lm.y };
  }

  // حساب القياسات أو قراءة اللقطة المعتمدة
  const rawResults = completed ? [] : computeAll(points, study.analysis.mmPerPixel ?? NaN);
  const table = presentCephMeasurements(rawResults,
    completed ? study.measurements : null, study.provenance);

  const enriched = enrichPresentedCephMeasurements(table, draftReference.refs, completed, draftReference.source);

  // حساب عمر المريض وقت تصوير الشععة
  let ageAtXray: number | null = null;
  if (patient?.birthYear) {
    const refYear = study.analysis.xrayDate
      ? new Date(study.analysis.xrayDate).getUTCFullYear()
      : new Date().getUTCFullYear();
    ageAtXray = Math.max(0, refYear - patient.birthYear);
  }

  // حساب أبعاد المخطط السيفالومتري للتوليد المتجهي
  const ptsList = Object.values(points).filter(Boolean);
  let minX = 0, minY = 0, maxX = 1000, maxY = 1000;
  if (ptsList.length > 0) {
    minX = Math.min(...ptsList.map((p) => p.x));
    minY = Math.min(...ptsList.map((p) => p.y));
    maxX = Math.max(...ptsList.map((p) => p.x));
    maxY = Math.max(...ptsList.map((p) => p.y));
    const pad = Math.max(40, (maxX - minX) * 0.1);
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
  }
  const viewBoxWidth = Math.max(200, maxX - minX);
  const viewBoxHeight = Math.max(200, maxY - minY);

  const guidePairs: [LandmarkCode, LandmarkCode, string][] = [
    ["S", "N", "#2563eb"],
    ["Or", "Po", "#0284c7"],
    ["Go", "Me", "#059669"],
    ["N", "A", "#64748b"],
    ["N", "B", "#64748b"],
    ["N", "Pog", "#0891b2"],
    ["A", "Pog", "#d97706"],
    ["ANS", "PNS", "#475569"],
    ["OcclA", "OcclP", "#e11d48"],
    ["U1A", "U1", "#7c3aed"],
    ["L1A", "L1", "#9333ea"],
    ["S", "Ar", "#8b5cf6"],
    ["Ar", "Go", "#8b5cf6"],
    ["S", "Gn", "#0d9488"],
    ["S", "Ba", "#0284c7"],
    ["N", "Ba", "#0ea5e9"],
  ];

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4" style={{ fontSize: "8.5pt", lineHeight: 1.4 }}>
      <p className="mb-2 border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{CEPH_UNAVAILABLE_NOTICE}</p>
      {!completed && <><CephScientificContext /><CephDraftReferenceEvidence context={draftReference} />
        <p role="note" className="p-2 text-xs">هذه قراءة جديدة لمسودة قابلة للتغيير وقت فتح الطباعة، وليست لقطة اعتماد أو نسخة مضمونة المطابقة للشاشة المفتوحة سابقًا.</p></>}
      {completed && <p role="note" className="mb-2 border border-amber-200 p-2 text-xs">{cephCompletionNotice(study.provenance)}</p>}

        <PrintHeader
          settings={settings}
          title="تقرير التحليل السيفالومتري الرقمي · Digital Cephalometric Report"
        />

        {/* بطاقة بيانات المريض والتحليل */}
        <PrintMetadata>
          <div>
            <span style={{ color: "#64748b" }}>المريض / Patient: </span>
            <b style={{ color: "#0f172a" }}>{patient?.fullName ?? `#${study.analysis.patientId}`}</b>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>رقم الملف / File #: </span>
            <span className="num" style={{ fontWeight: 600 }}>{study.analysis.patientId}</span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>الجنس / Gender: </span>
            <b>{patient?.gender === "male" ? "ذكر (Male)" : patient?.gender === "female" ? "أنثى (Female)" : "—"}</b>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>تاريخ الشععة / X-Ray: </span>
            <span>{study.analysis.xrayDate ?? "غير محدد"}</span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>العمر وقت الفحص / Age: </span>
            <b>{ageAtXray != null ? `${ageAtXray} سنة (Years)` : "—"}</b>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>مرحلة التقويم / Phase: </span>
            <b>{PHASE_LABEL[study.analysis.phase]?.ar ?? study.analysis.phase}</b>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>حالة التحليل / Status: </span>
            <b style={{ color: study.analysis.status === "completed" ? "#047857" : "#b45309" }}>
              {study.analysis.status === "completed" ? "معتمد (Confirmed)" : "مسودة (Draft)"}
            </b>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>المقياس / Scale: </span>
            <span className="num">
              {completed && !historical ? "المعايرة التاريخية غير موثّقة" : (historical?.snapshot.mmPerPixel ?? study.analysis.mmPerPixel) != null
                ? `${(1 / (historical?.snapshot.mmPerPixel ?? study.analysis.mmPerPixel)!).toFixed(1)} px/mm`
                : "غير معايَر"}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>المرجع / Ref Set: </span>
            <span style={{ fontSize: "7.5pt" }}>{completed ? historical?.referenceSet.name ?? "المرجع التاريخي غير موثّق" : draftReference.name}</span>
          </div>
        </PrintMetadata>
        {historical && <CephSavedCompletionEvidence witness={historical} />}

        {/* قسم المخطط الهندسي السيفالومتري والرسم التخطيطي */}
        {!completed && ptsList.length >= 4 && (
          <div className="print-watermark-protected" style={{
            margin: "2mm 0 3mm",
            border: "1px solid #e2e8f0",
            borderRadius: "2mm",
            padding: "2mm",
            backgroundColor: "#ffffff",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5mm" }}>
              <span style={{ fontSize: "8pt", fontWeight: 700, color: "#1e293b" }}>
                📐 المخطط السيفالومتري المتجهي · Cephalometric Tracing Geometry
              </span>
              <span style={{ fontSize: "7pt", color: "#64748b" }}>
                مقياس الرسم: 1:{study.analysis.mmPerPixel ? (study.analysis.mmPerPixel * 100).toFixed(0) : "100"} · الوجه يواجه اليمين (+x)
              </span>
            </div>
            <div style={{ width: "100%", height: "55mm", display: "flex", justifyContent: "center" }}>
              <svg
                viewBox={`${minX} ${minY} ${viewBoxWidth} ${viewBoxHeight}`}
                style={{ height: "100%", maxWidth: "100%", border: "1px solid #f1f5f9", backgroundColor: "#fafbfc" }}
              >
                {/* الخطوط السيفالومترية الأساسية */}
                {guidePairs.map(([a, b, col]) => {
                  const p1 = points[a];
                  const p2 = points[b];
                  if (!p1 || !p2) return null;
                  return (
                    <line
                      key={`${a}-${b}`}
                      x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                      stroke={col} strokeWidth="1.2"
                      strokeDasharray="4 2"
                      opacity="0.85"
                    />
                  );
                })}

                {/* إسقاطات ويتس العمودية على المستوى الإطباقي Wits Perpendicular Drops */}
                {(() => {
                  if (points.A && points.B && points.OcclA && points.OcclP) {
                    const pA = projectOnLine(points.A, points.OcclP, points.OcclA);
                    const pB = projectOnLine(points.B, points.OcclP, points.OcclA);
                    if (![pA.x, pA.y, pB.x, pB.y].every(Number.isFinite)) return null;
                    return (
                      <g key="print-wits-drops" stroke="#ef4444" strokeWidth="1" strokeDasharray="3 2" opacity="0.85">
                        <line x1={points.A.x} y1={points.A.y} x2={pA.x} y2={pA.y} />
                        <line x1={points.B.x} y1={points.B.y} x2={pB.x} y2={pB.y} />
                      </g>
                    );
                  }
                  return null;
                })()}

                {/* خط ريكتس الجمالي E-Line */}
                {points.Prn && points.PogS && (
                  <g key="print-eline">
                    <line
                      x1={points.Prn.x} y1={points.Prn.y}
                      x2={points.PogS.x} y2={points.PogS.y}
                      stroke="#db2777" strokeWidth="1.6"
                      strokeDasharray="5 2.5"
                    />
                    <text
                      x={(points.Prn.x + points.PogS.x) / 2 + 5}
                      y={(points.Prn.y + points.PogS.y) / 2}
                      fontSize="9" fill="#db2777" fontWeight="bold"
                    >
                      E-Line (Ricketts)
                    </text>
                  </g>
                )}

                {/* النقاط والمعالم التشريحية */}
                {(Object.keys(points) as LandmarkCode[]).map((code) => {
                  const pt = points[code];
                  if (!pt) return null;
                  const isSoftTissue = ["Prn", "Sn", "Ls", "Li", "PogS"].includes(code);
                  return (
                    <g key={code}>
                      <circle
                        cx={pt.x} cy={pt.y} r="3"
                        fill={isSoftTissue ? "#db2777" : "#0f172a"}
                        stroke="#ffffff" strokeWidth="1"
                      />
                      <text
                        x={pt.x + 4} y={pt.y - 4}
                        fontSize="8"
                        fill={isSoftTissue ? "#be185d" : "#1e293b"}
                        fontWeight={isSoftTissue ? "bold" : "normal"}
                      >
                        {code}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}

        {/* جدول القياسات السيفالومترية الشاملة */}
        <div style={{ margin: "2mm 0" }}>
          <h3 style={{ fontSize: "9pt", fontWeight: 800, margin: "2mm 0 1.5mm", color: "#0f172a" }}>
            {completed ? "📊 لقطة القياسات عند الاعتماد · Sealed Measurements" : "📊 قياسات المسودة · Draft Measurements"}
          </h3>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3mm" }}>
            {/* العمود الأيمن: الهيكل السهمي والعمودي */}
            <div>
              {(["sagittal", "vertical"] as const).map((group) => (
                <div key={group} style={{ marginBottom: "2.5mm" }}>
                  <div style={{
                    backgroundColor: "#f1f5f9",
                    padding: "1mm 2mm",
                    fontWeight: 700,
                    fontSize: "7.5pt",
                    color: "#334155",
                    borderBottom: "1px solid #cbd5e1",
                  }}>
                    {group === "sagittal" ? "الهيكل السهمي · Sagittal Skeletal" : "الهيكل العمودي · Vertical Skeletal"}
                  </div>
                  <PrintTableFrame><table className="items" style={{ fontSize: "7pt" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "right" }}>القياس / Parameter</th>
                        <th className="num">القيمة / Value</th>
                        <th className="num">أرقام المرجع / Catalog numbers</th>
                        <th>المصدر / Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enriched.filter((r) => r.group === group).map((r) => {
                        const refNorm = r.refMean != null && r.refSd != null
                          ? `${r.refMean}±${r.refSd}`
                          : "غير متاح";
                        return (
                          <tr key={r.code}>
                            <td>
                              <div>
                                <b>{r.code}</b>
                                <span style={{ color: "#64748b", marginInlineStart: "1.5mm", fontSize: "6.5pt" }}>
                                  {r.en}
                                </span>
                              </div>
                              {r.interpretationAr && (
                                <div style={{ fontSize: "6.5pt", color: "#475569", marginTop: "0.3mm" }}>
                                  {r.interpretationAr}
                                </div>
                              )}
                            </td>
                            <td className="num" style={{ fontWeight: 700, color: "#475569" }}>
                              {r.value != null ? `${r.value}${r.unit}` : "—"}
                            </td>
                            <td className="num" style={{ color: "#475569" }}>
                              {isQuarantinedCephMeasurement(r.code) ? "غير متاح" : (completed ? r.descriptiveOnly : isDescriptiveCephMeasurement(r.code)) ? "وصفي · بلا تصنيف" : refNorm}
                            </td>
                            <td style={{ fontSize: "6.5pt", color: "#475569" }}>{r.source}{completed && r.note ? <div>{r.note}</div> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></PrintTableFrame>
                </div>
              ))}
            </div>

            {/* العمود الأيسر: الأسنان والأنسجة الرخوة */}
            <div>
              {(["dental", "softTissue"] as const).map((group) => (
                <div key={group} style={{ marginBottom: "2.5mm" }}>
                  <div style={{
                    backgroundColor: "#f1f5f9",
                    padding: "1mm 2mm",
                    fontWeight: 700,
                    fontSize: "7.5pt",
                    color: "#334155",
                    borderBottom: "1px solid #cbd5e1",
                  }}>
                    {group === "dental" ? "العلاقة السنية والقواطع · Dental Analysis" : "الأنسجة الرخوة والبروفايل · Soft Tissue & Profile"}
                  </div>
                  <PrintTableFrame><table className="items" style={{ fontSize: "7pt" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "right" }}>القياس / Parameter</th>
                        <th className="num">القيمة / Value</th>
                        <th className="num">أرقام المرجع / Catalog numbers</th>
                        <th>المصدر / Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enriched.filter((r) => r.group === group).map((r) => {
                        const refNorm = r.refMean != null && r.refSd != null
                          ? `${r.refMean}±${r.refSd}`
                          : "غير متاح";
                        return (
                          <tr key={r.code}>
                            <td>
                              <div>
                                <b>{r.code}</b>
                                <span style={{ color: "#64748b", marginInlineStart: "1.5mm", fontSize: "6.5pt" }}>
                                  {r.en}
                                </span>
                              </div>
                              {r.interpretationAr && (
                                <div style={{ fontSize: "6.5pt", color: "#475569", marginTop: "0.3mm" }}>
                                  {r.interpretationAr}
                                </div>
                              )}
                            </td>
                            <td className="num" style={{ fontWeight: 700, color: "#475569" }}>
                              {r.value != null ? `${r.value}${r.unit}` : "—"}
                            </td>
                            <td className="num" style={{ color: "#475569" }}>
                              {isQuarantinedCephMeasurement(r.code) ? "غير متاح" : (completed ? r.descriptiveOnly : isDescriptiveCephMeasurement(r.code)) ? "وصفي · بلا تصنيف" : refNorm}
                            </td>
                            <td style={{ fontSize: "6.5pt", color: "#475569" }}>{r.source}{completed && r.note ? <div>{r.note}</div> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></PrintTableFrame>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* خلاصة التشخيص المعتمد وتوصيات العلاج */}
        <div style={{
          marginTop: "3mm",
          padding: "3mm",
          backgroundColor: "#f8fafc",
          border: "1.5px solid #0f172a",
          borderRadius: "2mm",
        }}>
          <h4 style={{ fontSize: "9pt", fontWeight: 800, margin: "0 0 2mm", color: "#0f172a" }}>
            {completed ? "التشخيص والملاحظات المحفوظة عند الاعتماد · Recorded Diagnosis & Notes" : "مسودة التشخيص وملاحظات الطبيب · Draft Diagnosis & Notes"}
          </h4>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2mm", fontSize: "8pt" }}>
            {diagnosis?.skeletal && (
              <div>
                <b style={{ color: "#1e3a5f" }}>التشخيص الهيكلي (Skeletal): </b>
                <span>{diagnosis.skeletal}</span>
              </div>
            )}
            {diagnosis?.dental && (
              <div>
                <b style={{ color: "#1e3a5f" }}>التشخيص السني (Dental): </b>
                <span>{diagnosis.dental}</span>
              </div>
            )}
            {diagnosis?.softTissue && (
              <div>
                <b style={{ color: "#1e3a5f" }}>الأنسجة والبروفايل (Soft Tissue): </b>
                <span>{diagnosis.softTissue}</span>
              </div>
            )}
            <div>
              <b style={{ color: "#1e3a5f" }}>الاستنتاج السيفالومتري (Conclusion): </b>
              <span style={{ fontWeight: 700, color: "#0f172a" }}>
                {diagnosis?.finalDx || "—"}
              </span>
            </div>
          </div>

          {diagnosis?.note && (
            <div style={{ marginTop: "2mm", paddingTop: "1.5mm", borderTop: "1px dashed #cbd5e1", fontSize: "8pt" }}>
              <b style={{ color: "#1e3a5f" }}>الملاحظات والخطة كما حُفظت: </b>
              <p style={{ margin: "1mm 0 0", whiteSpace: "pre-line", color: "#334155" }}>
                {diagnosis.note}
              </p>
            </div>
          )}
        </div>

        {historical && <div className="mt-3 break-all text-xs"><b>مصادر الحساب والمراجع المحفوظة وقت الاعتماد</b>
          <p>{historical.referenceSet.name} · {historical.referenceSet.version}</p>
          <p dir="ltr">Image SHA-256: {historical.image.sha256}</p>
          <p dir="ltr">Reference SHA-256: {historical.referenceSetSha256}</p>
          {historical.measurements.map(row => <p key={row.code}>{row.code}: {row.algorithm.id} · {row.algorithm.version} · {row.algorithm.calculationVersion ?? "—"} · {row.reference.source}
                <span dir="ltr"> · SHA-256: {row.algorithm.sourceSha256}</span>
                {row.reference.sourceUrl && <span> · {row.reference.sourceUrl}</span>}
                {row.reference.populationReference && <span> · عينة وصفية محفوظة، ليست معيارًا شخصيًا: {row.reference.populationReference.mean} ± {row.reference.populationReference.sd} · {row.reference.populationReference.population}</span>}</p>)}
        </div>}
        {/* سطر التوقيع والاعتماد */}
        <div className="sign-row" style={{ marginTop: "6mm" }}>
          <div>
            <p><b>{completed ? "المعتمِد المسجّل: " : "حالة الاعتماد: "}</b>{completed ? study.analysis.completedBy?.trim() || "غير موثّق في السجل" : "لم يُعتمد بعد"}</p>
            {!historical && study.diagnosis?.createdBy && <p><b>محرر التشخيص: </b>{study.diagnosis.createdBy}</p>}
            <p style={{ color: "#64748b", fontSize: "7pt" }}>
              {completed ? `تاريخ الاعتماد: ${study.analysis.completedAt ? friendlyDateLong(study.analysis.completedAt.split("T")[0]) : "غير موثّق في السجل"}` : "مسودة قيد المراجعة؛ الطباعة لا تعني الاعتماد"}
            </p>
          </div>
          <div style={{ textAlign: "center", minWidth: "50mm" }}>
            <p><b>{completed ? "توقيع وخاتم الطبيب المعالج" : "مكان التوقيع بعد المراجعة والاعتماد"}</b></p>
            <div style={{ height: "14mm", borderBottom: "1px solid #000", marginTop: "2mm" }} />
            <p style={{ fontSize: "7pt", color: "#64748b", marginTop: "1mm" }}>
              {settings["clinic.lead_doctor"]} — {settings["clinic.lead_doctor_title"]}
            </p>
          </div>
        </div>

        <div style={{ marginTop: "4mm" }}>
          <PrintFooter settings={settings} />
        </div>
      </div>
    </>
  );
}
