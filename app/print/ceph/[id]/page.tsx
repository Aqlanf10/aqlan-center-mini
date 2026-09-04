import { notFound } from "next/navigation";
import {
  getCephReferenceSet, getCephStudy, getPatient, getSettingsSafe,
} from "@/lib/db";
import {
  computeAll, enrichWithRefs, interpret, MEASUREMENTS, projectOnLine,
  type LandmarkCode, type LandmarkMap, type MeasurementResult,
} from "@/lib/ceph";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { friendlyDateLong } from "@/lib/reminders";

export const dynamic = "force-dynamic";

/** مؤشر الانحراف البياني المصغر للطباعة الورقية الرسمية (WebCeph Standard). */
function PrintDeviationGauge({
  value,
  mean,
  sd,
}: {
  value: number | null;
  mean: number;
  sd: number;
}) {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(sd) || sd <= 0) {
    return <div style={{ height: "3.5px", width: "35px", backgroundColor: "#e2e8f0", borderRadius: "1.5px", margin: "0 auto" }} />;
  }

  const z = (value - mean) / sd;
  let pos = 50 + (z * 15);
  pos = Math.max(5, Math.min(95, pos));

  return (
    <div style={{ position: "relative", width: "40px", height: "4.5px", backgroundColor: "#f1f5f9", borderRadius: "2px", margin: "0 auto" }}>
      <div style={{ display: "flex", width: "100%", height: "100%", borderRadius: "2px", overflow: "hidden", opacity: 0.85 }}>
        <div style={{ width: "20%", backgroundColor: "#f87171" }} />
        <div style={{ width: "15%", backgroundColor: "#fcd34d" }} />
        <div style={{ width: "30%", backgroundColor: "#34d399" }} />
        <div style={{ width: "15%", backgroundColor: "#fcd34d" }} />
        <div style={{ width: "20%", backgroundColor: "#f87171" }} />
      </div>
      <div style={{
        position: "absolute",
        top: "50%",
        left: `${pos}%`,
        transform: "translate(-50%, -50%)",
        width: "2.5px",
        height: "6.5px",
        backgroundColor: "#0f172a",
        borderRadius: "1px",
      }} />
    </div>
  );
}

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

  const patient = await getPatient(study.analysis.patientId);
  const refSet = await getCephReferenceSet(study.analysis.refSet);

  const points: LandmarkMap = {};
  for (const lm of study.landmarks) {
    points[lm.code] = { x: lm.x, y: lm.y };
  }

  // حساب القياسات أو قراءة اللقطة المعتمدة
  const rawResults = computeAll(points, study.analysis.mmPerPixel ?? NaN);
  const table: MeasurementResult[] = study.analysis.status === "completed" && study.measurements.length > 0
    ? (() => {
        const snap = new Map(study.measurements.map((s) => [s.code, s.value]));
        return rawResults.map((r) => {
          const v = snap.get(r.code);
          if (v == null || !Number.isFinite(v)) return { ...r, value: null, display: "—", status: null };
          const def = MEASUREMENTS.find((d) => d.code === r.code);
          return { ...r, value: v, display: String(v), status: def ? interpret(v, def) : r.status };
        });
      })()
    : rawResults;

  const enriched = enrichWithRefs(table, refSet?.values ?? null);

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
  ];

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4" style={{ fontSize: "8.5pt", lineHeight: 1.4 }}>
        <PrintHeader
          settings={settings}
          title="تقرير التحليل السيفالومتري الرقمي · Digital Cephalometric Report"
        />

        {/* بطاقة بيانات المريض والتحليل */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "2mm",
          backgroundColor: "#f8fafc",
          border: "1px solid #cbd5e1",
          borderRadius: "2mm",
          padding: "2.5mm 3.5mm",
          margin: "2.5mm 0",
          fontSize: "8pt",
        }}>
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
              {study.analysis.mmPerPixel != null
                ? `${(1 / study.analysis.mmPerPixel).toFixed(1)} px/mm`
                : "غير معايَر"}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>المرجع / Ref Set: </span>
            <span style={{ fontSize: "7.5pt" }}>{refSet?.name ?? "المعدلات القياسية المدمجة"}</span>
          </div>
        </div>

        {/* قسم المخطط الهندسي السيفالومتري والرسم التخطيطي */}
        {ptsList.length >= 4 && (
          <div style={{
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
            📊 جدول القياسات السيفالومترية المعتمدة · Cephalometric Measurements Table
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
                  <table className="items" style={{ fontSize: "7.5pt" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "right" }}>القياس / Parameter</th>
                        <th className="num">القيمة / Value</th>
                        <th className="num">المرجع / Norm</th>
                        <th style={{ textAlign: "center" }}>المؤشر / Gauge</th>
                        <th style={{ textAlign: "center" }}>الحالة / Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enriched.filter((r) => r.group === group).map((r) => {
                        const statusLabel = r.refLabel
                          ?? (r.status === "above" ? "أعلى من المدى" : r.status === "below" ? "أدنى من المدى" : r.status === "within" ? "طبيعي" : "—");
                        const statusColor = r.status === "above" ? "#1d4ed8" : r.status === "below" ? "#b91c1c" : "#047857";
                        const refNorm = r.refMean != null && r.refSd != null
                          ? `${r.refMean}±${r.refSd}`
                          : `${r.mean}±${r.tol}`;
                        return (
                          <tr key={r.code}>
                            <td>
                              <b>{r.code}</b>
                              <span style={{ color: "#64748b", marginInlineStart: "1.5mm", fontSize: "7pt" }}>
                                {r.en}
                              </span>
                            </td>
                            <td className="num" style={{ fontWeight: 700, color: statusColor }}>
                              {r.value != null ? `${r.value}${r.unit}` : "—"}
                            </td>
                            <td className="num" style={{ color: "#475569" }}>
                              {refNorm} {r.unit}
                            </td>
                            <td style={{ textAlign: "center", verticalAlign: "middle" }}>
                              <PrintDeviationGauge
                                value={r.value}
                                mean={r.refMean ?? r.mean}
                                sd={r.refSd ?? r.tol}
                              />
                            </td>
                            <td style={{ textAlign: "center", color: statusColor, fontSize: "7pt" }}>
                              {statusLabel}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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
                  <table className="items" style={{ fontSize: "7.5pt" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "right" }}>القياس / Parameter</th>
                        <th className="num">القيمة / Value</th>
                        <th className="num">المرجع / Norm</th>
                        <th style={{ textAlign: "center" }}>المؤشر / Gauge</th>
                        <th style={{ textAlign: "center" }}>الحالة / Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enriched.filter((r) => r.group === group).map((r) => {
                        const statusLabel = r.refLabel
                          ?? (r.status === "above" ? "أعلى من المدى" : r.status === "below" ? "أدنى من المدى" : r.status === "within" ? "طبيعي" : "—");
                        const statusColor = r.status === "above" ? "#1d4ed8" : r.status === "below" ? "#b91c1c" : "#047857";
                        const refNorm = r.refMean != null && r.refSd != null
                          ? `${r.refMean}±${r.refSd}`
                          : `${r.mean}±${r.tol}`;
                        return (
                          <tr key={r.code}>
                            <td>
                              <b>{r.code}</b>
                              <span style={{ color: "#64748b", marginInlineStart: "1.5mm", fontSize: "7pt" }}>
                                {r.en}
                              </span>
                            </td>
                            <td className="num" style={{ fontWeight: 700, color: statusColor }}>
                              {r.value != null ? `${r.value}${r.unit}` : "—"}
                            </td>
                            <td className="num" style={{ color: "#475569" }}>
                              {refNorm} {r.unit}
                            </td>
                            <td style={{ textAlign: "center", verticalAlign: "middle" }}>
                              <PrintDeviationGauge
                                value={r.value}
                                mean={r.refMean ?? r.mean}
                                sd={r.refSd ?? r.tol}
                              />
                            </td>
                            <td style={{ textAlign: "center", color: statusColor, fontSize: "7pt" }}>
                              {statusLabel}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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
            🩺 الخلاصة التشخيصية المعتمدة وتوصيات خطة العلاج · Orthodontic Diagnosis & Plan
          </h4>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2mm", fontSize: "8pt" }}>
            {study.diagnosis?.skeletal && (
              <div>
                <b style={{ color: "#1e3a5f" }}>التشخيص الهيكلي (Skeletal): </b>
                <span>{study.diagnosis.skeletal}</span>
              </div>
            )}
            {study.diagnosis?.dental && (
              <div>
                <b style={{ color: "#1e3a5f" }}>التشخيص السني (Dental): </b>
                <span>{study.diagnosis.dental}</span>
              </div>
            )}
            {study.diagnosis?.softTissue && (
              <div>
                <b style={{ color: "#1e3a5f" }}>الأنسجة والبروفايل (Soft Tissue): </b>
                <span>{study.diagnosis.softTissue}</span>
              </div>
            )}
            <div>
              <b style={{ color: "#1e3a5f" }}>الاستنتاج السيفالومتري (Conclusion): </b>
              <span style={{ fontWeight: 700, color: "#0f172a" }}>
                {study.diagnosis?.finalDx || "—"}
              </span>
            </div>
          </div>

          {study.diagnosis?.note && (
            <div style={{ marginTop: "2mm", paddingTop: "1.5mm", borderTop: "1px dashed #cbd5e1", fontSize: "8pt" }}>
              <b style={{ color: "#1e3a5f" }}>توصيات خطة العلاج وملاحظات الطبيب المعالج: </b>
              <p style={{ margin: "1mm 0 0", whiteSpace: "pre-line", color: "#334155" }}>
                {study.diagnosis.note}
              </p>
            </div>
          )}
        </div>

        {/* سطر التوقيع والاعتماد */}
        <div className="sign-row" style={{ marginTop: "6mm" }}>
          <div>
            <p><b>حرر واعُتمد بواسطة: </b>{study.analysis.completedBy || study.diagnosis?.createdBy || session.username}</p>
            <p style={{ color: "#64748b", fontSize: "7pt" }}>
              تاريخ الاعتماد: {study.analysis.completedAt ? friendlyDateLong(study.analysis.completedAt.split("T")[0]) : "مسودة قيد المراجعة"}
            </p>
          </div>
          <div style={{ textAlign: "center", minWidth: "50mm" }}>
            <p><b>توقيع وخاتم الطبيب المعالج</b></p>
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
