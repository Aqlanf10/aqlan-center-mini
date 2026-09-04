import { notFound } from "next/navigation";
import { getPatientFile, getSettingsSafe, patientChart, patientLedger } from "@/lib/db";
import { PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { clinicDateString } from "@/lib/schedule";
import { friendlyDateLong } from "@/lib/reminders";
import {
  ageFromBirthYear,
  ageText,
  GENDER_LABEL,
  parseMedicalAlerts,
  getBloodPressureRisk,
} from "@/lib/patient";
import {
  CONDITION_LABEL,
  STAGE_LABEL,
  toothName,
  toUniversal,
} from "@/lib/dental";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

/**
 * الملف الطبي السريري الشامل للمريض (Comprehensive Patient Dossier) — طباعة A4 رسمية.
 *
 * وثيقة سريرية دولية معتمدة للإحالات الطبية، تقارير التأمين، وأرشفة ملف المريض:
 * - البيانات الديموغرافية والتعريفية.
 * - محطة العلامات الحيوية وفصيلة الدم وتقييم ضغط الدم.
 * - التنبيهات الطبية والحساسيات والأمراض المزمنة.
 * - تشريح ومخطط الأسنان وحالات الأسنان الموثقة (FDI و Universal).
 * - سجل الزيارات والإجراءات المنجزة.
 * - الملخص المالي والذمة المتبقية.
 * - توقيع وختم الطبيب المعالج.
 */
export default async function PatientDossierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const today = clinicDateString(new Date(), "Asia/Aden");

  const [patientData, chartData, ledgerData, settings] = await Promise.all([
    getPatientFile(id).catch(() => null),
    patientChart(id).catch(() => null),
    patientLedger(id).catch(() => null),
    getSettingsSafe(),
  ]);

  if (!patientData) notFound();

  const { patient, visits } = patientData;
  const age = ageFromBirthYear(patient.birthYear, today);
  const { badges, customNote, vitals } = parseMedicalAlerts(patient.medicalAlert);
  const bpRisk = getBloodPressureRisk(vitals?.bpSystolic, vitals?.bpDiastolic);

  const chartRecords = chartData?.records ?? [];
  const chartSummary = chartData?.summary ?? {
    charted: 0,
    caries: 0,
    planned: 0,
    completed: 0,
    absent: 0,
  };

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4" dir="rtl">
        <PrintHeader settings={settings} title="الملف الطبي السريري الشامل للمريض (Medical Dossier)" />

        {/* 1. بيانات المريض التعريفية */}
        <div style={{ margin: "2mm 0 4mm", padding: "3mm", background: "#f8fafc", borderRadius: "2mm", border: "1px solid #e2e8f0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2mm", fontSize: "10pt" }}>
            <div className="line" style={{ margin: 0 }}>
              <span style={{ color: "#64748b" }}>اسم المريض:</span>
              <span style={{ fontWeight: 800, fontSize: "11pt", color: "#0f172a" }}>{patient.fullName}</span>
            </div>
            <div className="line" style={{ margin: 0 }}>
              <span style={{ color: "#64748b" }}>رقم الملف الطبي:</span>
              <span className="num" style={{ fontWeight: 800, color: "#0369a1" }}>#{patient.patientNumber}</span>
            </div>
            <div className="line" style={{ margin: 0 }}>
              <span style={{ color: "#64748b" }}>الجنس والعمر:</span>
              <span>{GENDER_LABEL[patient.gender]} · {ageText(age)}</span>
            </div>
            <div className="line" style={{ margin: 0 }}>
              <span style={{ color: "#64748b" }}>رقم الهاتف:</span>
              <span className="num" dir="ltr">{patient.phone || "—"}</span>
            </div>
            {patient.address && (
              <div className="line" style={{ margin: 0, gridColumn: "span 2" }}>
                <span style={{ color: "#64748b" }}>العنوان:</span>
                <span>{patient.address}</span>
              </div>
            )}
            <div className="line" style={{ margin: 0, gridColumn: "span 2", fontSize: "8.5pt", color: "#64748b" }}>
              <span>تاريخ التسجيل بالمركز:</span>
              <span>{friendlyDateLong(patient.createdAt.slice(0, 10))}</span>
            </div>
          </div>
        </div>

        {/* 2. محطة العلامات الحيوية وفصيلة الدم */}
        <div style={{ margin: "3mm 0", border: "1px solid #cbd5e1", borderRadius: "2mm", overflow: "hidden" }}>
          <div style={{ background: "#0f172a", color: "#fff", padding: "1.5mm 3mm", fontSize: "9.5pt", fontWeight: 700 }}>
            🩺 العلامات الحيوية ومؤشرات الخطورة السريرية (Vital Signs)
          </div>
          <div style={{ padding: "2.5mm 3mm", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "2mm", textAlign: "center" }}>
            <div style={{ borderRight: "1px solid #e2e8f0", paddingRight: "2mm" }}>
              <div style={{ fontSize: "8pt", color: "#64748b" }}>ضغط الدم (BP)</div>
              <div style={{ fontWeight: 800, fontSize: "11pt", color: bpRisk.severity === "critical" || bpRisk.severity === "high" ? "#dc2626" : "#0f172a" }}>
                {vitals?.bpSystolic && vitals?.bpDiastolic ? `${vitals.bpSystolic}/${vitals.bpDiastolic} mmHg` : "غير مسجل"}
              </div>
              <div style={{ fontSize: "7.5pt", fontWeight: 700, color: bpRisk.severity === "critical" ? "#dc2626" : bpRisk.severity === "medium" ? "#d97706" : "#059669" }}>
                {bpRisk.label}
              </div>
            </div>

            <div style={{ borderRight: "1px solid #e2e8f0", paddingRight: "2mm" }}>
              <div style={{ fontSize: "8pt", color: "#64748b" }}>النبض (Pulse)</div>
              <div style={{ fontWeight: 800, fontSize: "11pt", color: "#0f172a" }}>
                {vitals?.pulse ? `${vitals.pulse} bpm` : "—"}
              </div>
              <div style={{ fontSize: "7.5pt", color: "#64748b" }}>معدل ضربات القلب</div>
            </div>

            <div style={{ borderRight: "1px solid #e2e8f0", paddingRight: "2mm" }}>
              <div style={{ fontSize: "8pt", color: "#64748b" }}>السكر العشوائي (RBS)</div>
              <div style={{ fontWeight: 800, fontSize: "11pt", color: vitals?.bloodSugar && vitals.bloodSugar >= 200 ? "#dc2626" : "#0f172a" }}>
                {vitals?.bloodSugar ? `${vitals.bloodSugar} mg/dL` : "—"}
              </div>
              <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
                {vitals?.bloodSugar ? (vitals.bloodSugar >= 200 ? "مرتفع" : "طبيعي") : "غير مسجل"}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "8pt", color: "#64748b" }}>فصيلة الدم (Blood Group)</div>
              <div style={{ fontWeight: 900, fontSize: "13pt", color: "#b91c1c" }}>
                {vitals?.bloodGroup || "—"}
              </div>
              <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
                {vitals?.recordedAt ? `تاريخ: ${vitals.recordedAt}` : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* 3. التنبيهات الطبية والسوابق المرضية والحساسية */}
        <div style={{ margin: "3mm 0", border: "1px solid #fca5a5", background: "#fff1f2", borderRadius: "2mm", padding: "2.5mm 3mm" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "2mm", marginBottom: "1.5mm" }}>
            <span style={{ fontSize: "12pt" }}>⚠️</span>
            <span style={{ fontWeight: 800, fontSize: "9.5pt", color: "#9f1239" }}>
              السوابق المرضية والتنبيهات السريرية (Medical Alerts & Allergies):
            </span>
          </div>
          {badges.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "2mm", marginBottom: "1.5mm" }}>
              {badges.map((b) => (
                <span
                  key={b.id}
                  style={{
                    background: "#fee2e2",
                    color: "#991b1b",
                    border: "1px solid #f87171",
                    borderRadius: "1.5mm",
                    padding: "0.5mm 2.5mm",
                    fontSize: "8.5pt",
                    fontWeight: 700,
                  }}
                >
                  {b.icon} {b.label}
                </span>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: "8.5pt", color: "#475569" }}>
              لا توجد حساسية أو أمراض مزمنة شائعة مسجلة في ملف المريض.
            </p>
          )}
          {customNote && (
            <p style={{ margin: "1.5mm 0 0", fontSize: "8.5pt", color: "#881337", fontWeight: 600 }}>
              ملاحظة الطبيب: {customNote}
            </p>
          )}
        </div>

        {/* 4. ملخص تشخيص ومخطط الأسنان */}
        <div style={{ margin: "3mm 0" }}>
          <h3 style={{ fontSize: "10pt", fontWeight: 800, margin: "0 0 1.5mm", color: "#0f172a" }}>
            🦷 ملخص تشخيص الأسنان (Dental Chart Breakdown)
          </h3>
          <div style={{ display: "flex", gap: "2mm", marginBottom: "2mm", fontSize: "8.5pt" }}>
            <span style={{ background: "#f1f5f9", padding: "1mm 2.5mm", borderRadius: "1.5mm" }}>
              الأسنان الموثقة: <strong>{chartSummary.charted}</strong>
            </span>
            <span style={{ background: "#fee2e2", color: "#991b1b", padding: "1mm 2.5mm", borderRadius: "1.5mm" }}>
              تسوّس نشط: <strong>{chartSummary.caries}</strong>
            </span>
            <span style={{ background: "#fef3c7", color: "#92400e", padding: "1mm 2.5mm", borderRadius: "1.5mm" }}>
              خطة علاج مقترحة: <strong>{chartSummary.planned}</strong>
            </span>
            <span style={{ background: "#dcfce7", color: "#166534", padding: "1mm 2.5mm", borderRadius: "1.5mm" }}>
              إجراءات منجزة: <strong>{chartSummary.completed}</strong>
            </span>
            <span style={{ background: "#e2e8f0", color: "#475569", padding: "1mm 2.5mm", borderRadius: "1.5mm" }}>
              مفقود/مخلوع: <strong>{chartSummary.absent}</strong>
            </span>
          </div>

          {chartRecords.length > 0 ? (
            <table style={{ width: "100%", fontSize: "8pt", borderCollapse: "collapse", textAlign: "right" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #cbd5e1" }}>
                  <th style={{ padding: "1.5mm" }}>رقم السن (FDI / Univ)</th>
                  <th style={{ padding: "1.5mm" }}>الاسم التشريحي</th>
                  <th style={{ padding: "1.5mm" }}>الحالة السريرية</th>
                  <th style={{ padding: "1.5mm" }}>المرحلة</th>
                  <th style={{ padding: "1.5mm" }}>الأسطح</th>
                  <th style={{ padding: "1.5mm" }}>ملاحظات الطبيب</th>
                </tr>
              </thead>
              <tbody>
                {chartRecords.slice(-10).map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "1.5mm", fontWeight: 700 }} className="num">
                      {r.toothCode} (#{toUniversal(r.toothCode)})
                    </td>
                    <td style={{ padding: "1.5mm" }}>{toothName(r.toothCode)}</td>
                    <td style={{ padding: "1.5mm", fontWeight: 700 }}>{CONDITION_LABEL[r.condition]}</td>
                    <td style={{ padding: "1.5mm" }}>{STAGE_LABEL[r.stage]}</td>
                    <td style={{ padding: "1.5mm" }} className="num">{r.surfaces || "—"}</td>
                    <td style={{ padding: "1.5mm", color: "#64748b" }}>{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ margin: "2mm 0", fontSize: "8.5pt", color: "#64748b" }}>لا توجد إجراءات مسجلة على المخطط السني بعد.</p>
          )}
        </div>

        {/* 5. سجل الزيارات والمعالجات السريرية */}
        <div style={{ margin: "3mm 0" }}>
          <h3 style={{ fontSize: "10pt", fontWeight: 800, margin: "0 0 1.5mm", color: "#0f172a" }}>
            📋 تاريخ الزيارات السريرية السابقة ({visits.length} زيارة)
          </h3>
          {visits.length > 0 ? (
            <table style={{ width: "100%", fontSize: "8pt", borderCollapse: "collapse", textAlign: "right" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #cbd5e1" }}>
                  <th style={{ padding: "1.5mm" }}>التاريخ</th>
                  <th style={{ padding: "1.5mm" }}>الكرسي / العيادة</th>
                  <th style={{ padding: "1.5mm" }}>الحالة</th>
                  <th style={{ padding: "1.5mm" }}>ملاحظة الزيارة</th>
                </tr>
              </thead>
              <tbody>
                {visits.slice(0, 6).map((v) => (
                  <tr key={v.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "1.5mm" }}>{friendlyDateLong(v.arrivedAt.slice(0, 10))}</td>
                    <td style={{ padding: "1.5mm", fontWeight: 600 }}>{v.chair ? `الكرسي #${v.chair}` : "العيادة العامة"}</td>
                    <td style={{ padding: "1.5mm" }}>
                      {v.status === "done" ? "مكتملة ✓" : v.status === "in_chair" ? "على الكرسي" : "في الانتظار"}
                    </td>
                    <td style={{ padding: "1.5mm", color: "#64748b" }}>{v.note || "كشف ومعاينة سريرية"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ margin: "2mm 0", fontSize: "8.5pt", color: "#64748b" }}>لا توجد زيارات سابقة موثقة.</p>
          )}
        </div>

        {/* 6. الموقف المالي للمريض */}
        {(() => {
          const invoices = ledgerData?.invoices ?? [];
          const payments = ledgerData?.payments ?? [];
          const billed =
            invoices.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.totalMinor, 0) +
            (ledgerData?.opening?.amountMinor ?? 0);
          const paid = payments.reduce(
            (sum, p) => sum + (p.kind === "refund" ? -p.baseAmountMinor : p.baseAmountMinor),
            0,
          );
          const balance = billed - paid;
          const curr = invoices[0]?.baseCurrency ?? "YER";

          return (
            <div style={{ margin: "3mm 0", padding: "2mm 3mm", background: "#f8fafc", borderRadius: "2mm", border: "1px solid #e2e8f0", fontSize: "8.5pt" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  إجمالي الفواتير: <strong>{formatMoney(billed, curr)}</strong>
                </span>
                <span>
                  إجمالي المسدد: <strong>{formatMoney(paid, curr)}</strong>
                </span>
                <span style={{ fontWeight: 800, color: balance > 0 ? "#b91c1c" : "#059669" }}>
                  الرصيد المتبقي (الذمة): {formatMoney(balance, curr)}
                </span>
              </div>
            </div>
          );
        })()}

        <div className="rule" style={{ margin: "4mm 0 2mm" }} />

        {/* 7. التوقيع والاعتماد السريري */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6mm", margin: "4mm 0", fontSize: "9pt", textAlign: "center" }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: "12mm" }}>توقيع وخاتم الطبيب المعالج:</div>
            <div style={{ borderBottom: "1px dashed #94a3b8", width: "60%", margin: "0 auto" }}></div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: "12mm" }}>اعتماد الإدارة الطبية / الختم الرسمي:</div>
            <div style={{ borderBottom: "1px dashed #94a3b8", width: "60%", margin: "0 auto" }}></div>
          </div>
        </div>

        <div style={{ textAlign: "center", fontSize: "7.5pt", color: "#94a3b8", marginTop: "2mm" }}>
          وثيقة طبية رسمية صادرة آلياً من نظام إدارة مركز الأسنان · {friendlyDateLong(today)}
        </div>
      </div>
    </>
  );
}
