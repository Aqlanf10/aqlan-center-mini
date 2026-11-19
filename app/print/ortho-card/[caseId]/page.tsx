import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getOrthoCase, getPatient, getSettingsSafe, patientAppointmentsFrom } from "@/lib/db";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { ElasticCellView, WireCellView } from "@/components/OrthoWireTimeline";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { clinicDateString } from "@/lib/schedule";
import { upcomingAppointments } from "@/lib/patientCard";
import {
  APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, PHASE_LABEL, RETAINER_LABEL, SLOT_LABEL,
} from "@/lib/ortho";
import { buildWireSessionView, type WireArch } from "@/lib/ortho-wire-timeline";

export const dynamic = "force-dynamic";

/**
 * OC-1 — بطاقة علاج التقويم المطبوعة (قراءة فقط).
 * العقد: docs/review/ortho-treatment-card-followup-gaps-contract-20261119.md (v1.1).
 *
 * نسخة واحدة تصلح للملف والمريض والإحالة: لا مال، ولا ملاحظات طبيب خاصة، ولا هاتف.
 * مسار الأسلاك بالدلالة المعتمدة نفسها (buildWireSessionView): الفراغ «بلا تغيير»،
 * والمسجّل مجددًا خافت، والإزالة بدليل موثّق فقط، والأحدث أولًا، ولا اقتراح.
 */

const ID = /^[1-9]\d{0,9}$/;
const ARCH_LABEL: Record<WireArch, string> = { upper: "العلوي", lower: "السفلي" };
const ARCH_TITLE: Record<WireArch, string> = { upper: "الفك العلوي", lower: "الفك السفلي" };

const PAGE_STYLES = `
  @media print { @page { size: A4; } thead { display: table-header-group; } tr { break-inside: avoid; } }
  .ortho-card-sheet table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  .ortho-card-sheet th, .ortho-card-sheet td { border-bottom: 0.2mm solid #e2e8f0; padding: 1.2mm 1.5mm; text-align: right; vertical-align: top; }
  .ortho-card-sheet th { color: #075985; font-weight: 700; border-bottom: 0.4mm solid #bae6fd; }
  .ortho-card-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5mm 6mm; margin: 3mm 0; }
  .ortho-card-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3mm; margin: 3mm 0; }
  .ortho-card-summary > div { border: 0.3mm solid #bae6fd; border-radius: 1.5mm; padding: 2mm; background: #f0f9ff; }
  @media screen and (max-width: 600px) {
    .ortho-card-sheet { width: 100% !important; min-height: 0 !important; padding: 6mm 4mm !important; box-sizing: border-box; }
    .ortho-card-facts, .ortho-card-summary { grid-template-columns: 1fr !important; }
  }
`;

function Message({ text }: { text: string }) {
  return (
    <div className="sheet sheet-a4 ortho-card-sheet" style={{ padding: "10mm 12mm" }}>
      <p role="alert" style={{ border: "1.5px solid #b91c1c", borderRadius: "2mm", padding: "4mm", color: "#7f1d1d", backgroundColor: "#fef2f2", fontWeight: 700 }}>{text}</p>
    </div>
  );
}

function DateText({ value }: { value: string }) {
  return <bdi dir="ltr">{value}</bdi>;
}

function monthsText(value: number): string {
  if (!Number.isInteger(value)) return value < 3 ? `${value} شهر` : `${value} شهرًا`;
  if (value === 1) return "شهر واحد";
  if (value === 2) return "شهران";
  return value >= 3 && value <= 10 ? `${value} أشهر` : `${value} شهرًا`;
}

function weeksText(weeks: number): string {
  if (weeks === 0) return "أقل من أسبوع";
  return weeks === 1 ? "أسبوع واحد" : weeks === 2 ? "أسبوعان" : weeks <= 10 ? `${weeks} أسابيع` : `${weeks} أسبوعًا`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span style={{ color: "#64748b" }}>{label}: </span><strong>{children}</strong></div>;
}

export default async function OrthoTreatmentCardPage({ params }: { params: Promise<{ caseId: string }> }) {
  const session = await requireSession();
  if (!session) return <Message text="انتهت الجلسة. سجّل الدخول من جديد." />;

  const { caseId: rawCaseId } = await params;
  if (!ID.test(rawCaseId)) notFound();
  const caseId = Number(rawCaseId);
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

  const orthoCase = await getOrthoCase(caseId, today).catch(() => null);
  if (!orthoCase) notFound();
  // حرس الباب: من لا يصل إلى المريض يرى «غير موجود» نفسه، قبل أي قراءة أخرى.
  if (!(await canAccessPatient(session, orthoCase.patientId).catch(() => false))) notFound();

  const [patient, settings, appointments] = await Promise.all([
    getPatient(orthoCase.patientId), getSettingsSafe(), patientAppointmentsFrom(orthoCase.patientId, today),
  ]);
  if (!patient) notFound();
  // الموعد القادم بالدوال نفسها التي تطبعه بطاقة المريض: التاريخ والوقت فقط.
  const next = upcomingAppointments(appointments, today, 1)[0] ?? null;

  const view = buildWireSessionView({
    case: { slot: orthoCase.slot, appliance: orthoCase.appliance, arches: orthoCase.arches, upperWire: orthoCase.upperWire, lowerWire: orthoCase.lowerWire },
    adjustments: orthoCase.adjustments,
    documentedRemovals: orthoCase.documentedWireRemovals ?? [],
    hasMore: false,
  });
  const progress = orthoCase.progress;

  return (
    <>
      <style>{PAGE_STYLES}</style>
      <PrintButton />
      <div className="sheet sheet-a4 ortho-card-sheet" style={{ padding: "10mm 12mm", fontSize: "9pt" }}>
        <PrintHeader settings={settings} title="بطاقة علاج التقويم" />

        <div className="ortho-card-facts">
          <Fact label="اسم المريض">{patient.fullName}</Fact>
          <Fact label="رقم الملف"><DateText value={patient.patientNumber} /></Fact>
          <Fact label="الحالة"><bdi dir="ltr">#{orthoCase.id}</bdi> · {CASE_STATUS_LABEL[orthoCase.status]}</Fact>
          <Fact label="الجهاز">{APPLIANCE_LABEL[orthoCase.appliance]}</Fact>
          <Fact label="الفكّان">{ARCHES_LABEL[orthoCase.arches]}</Fact>
          <Fact label="القياس">{SLOT_LABEL[orthoCase.slot]}{orthoCase.bracketSystem ? <> · <bdi dir="ltr">{orthoCase.bracketSystem}</bdi></> : null}</Fact>
          <Fact label="بدء العلاج"><DateText value={orthoCase.startDate} /></Fact>
          <Fact label="المدة المخططة">{monthsText(orthoCase.plannedMonths)}</Fact>
          <Fact label="المنقضي">{monthsText(progress.monthsElapsed)} ({progress.percent}%)</Fact>
          <Fact label="المرحلة">{PHASE_LABEL[orthoCase.phase]}</Fact>
          <Fact label="الطبيب المسؤول">{orthoCase.responsibleDoctorName ?? "غير محدد"}</Fact>
          <Fact label="المثبّت">{orthoCase.retainer ? <>{RETAINER_LABEL[orthoCase.retainer]}{orthoCase.retainerOn ? <> · <DateText value={orthoCase.retainerOn} /></> : null}</> : "لم يُركَّب"}</Fact>
        </div>

        <p style={{ margin: "2mm 0", fontWeight: 700 }}>
          الموعد القادم: {next ? <><DateText value={next.scheduledDate} /> · <DateText value={next.scheduledTime} /></> : "لا موعد محجوز قادم"}
        </p>

        {view.kind === "not_applicable" ? (
          <p style={{ marginTop: "3mm", color: "#475569" }}>هذا الجهاز لا يستخدم أسلاكًا.</p>
        ) : (
          <>
            <p style={{ marginTop: "3mm", fontWeight: 800, color: "#075985" }}>مسار الأسلاك</p>
            <div className="ortho-card-summary">
              {view.summary.map(item => (
                <div key={item.arch}>
                  <p style={{ margin: 0, fontWeight: 700, color: "#075985" }}>{ARCH_TITLE[item.arch]}</p>
                  <p style={{ margin: "1mm 0", fontWeight: 800 }}>
                    {item.kind === "wire" ? <bdi dir="ltr">{item.text}</bdi> : item.kind === "none" ? "بلا سلك — إزالة موثّقة" : "لا سلك موثّق بعد"}
                  </p>
                  {item.firstDocumentedOn ? (
                    <p style={{ margin: 0, color: "#475569" }}>
                      {item.kind === "none" ? "منذ" : "أول تسجيل موثّق"}: <DateText value={item.firstDocumentedOn} />
                      {item.kind === "wire" && item.documentedWeeks !== null ? <> · الفترة الموثّقة: {weeksText(item.documentedWeeks)}</> : null}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            {view.rows.length === 0 ? <p style={{ color: "#64748b" }}>لا جلسات مسجّلة بعد.</p> : (
              <table>
                <thead>
                  <tr>
                    <th>التاريخ</th>
                    {view.arches.map(arch => <th key={arch}>{ARCH_LABEL[arch]}</th>)}
                    <th>المطاط</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(row => (
                    <tr key={row.id}>
                      <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}><DateText value={row.doneOn} /></td>
                      {view.arches.map(arch => {
                        const cell = arch === "upper" ? row.upper : row.lower;
                        return <td key={arch}>{cell ? <WireCellView cell={cell} /> : null}</td>;
                      })}
                      <td><ElasticCellView cell={row.elastics} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "10mm", gap: "8mm" }}>
          <p style={{ margin: 0, color: "#475569" }}>طُبعت في: <DateText value={today} /></p>
          <p style={{ margin: 0, minWidth: "60mm", borderTop: "0.3mm solid #334155", paddingTop: "1mm", textAlign: "center" }}>توقيع الطبيب المعالج</p>
        </div>
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
