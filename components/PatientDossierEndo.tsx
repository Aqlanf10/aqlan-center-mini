import type { EndoTreatmentView, EndoVisitView } from "@/lib/endodontics-db";
import {
  APICAL_LABEL, ENDO_KIND_LABEL, ENDO_STAGE_LABEL, ENDO_STATUS_LABEL, MEASUREMENT_METHOD_LABEL,
  PROGNOSIS_LABEL, PULPAL_LABEL, REFERENCE_POINT_LABEL, RESTORATIVE_LABEL, TENDERNESS_LABEL,
  VITALITY_LABEL, hasMeaningfulEndoRecord,
} from "@/lib/endodontics";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

type Detail = { label: string; value: string };

function clinicalDetails(visit: EndoVisitView): Detail[] {
  const fields: [string, string | number | null][] = [
    ["الشكوى الرئيسية", visit.chiefComplaint], ["الأعراض", visit.symptoms],
    ["تشخيص اللب", visit.pulpalDiagnosis ? PULPAL_LABEL[visit.pulpalDiagnosis] : null],
    ["تشخيص الذروة", visit.apicalDiagnosis ? APICAL_LABEL[visit.apicalDiagnosis] : null],
    ["اختبار البارد", visit.vitalityCold ? VITALITY_LABEL[visit.vitalityCold] : null],
    ["اختبار الحار", visit.vitalityHeat ? VITALITY_LABEL[visit.vitalityHeat] : null],
    ["الاختبار الكهربائي", visit.vitalityEpt ? VITALITY_LABEL[visit.vitalityEpt] : null],
    ["القرع", visit.percussion ? TENDERNESS_LABEL[visit.percussion] : null],
    ["الجس", visit.palpation ? TENDERNESS_LABEL[visit.palpation] : null],
    ["درجة الحركة", visit.mobilityGrade], ["فحص اللثة", visit.perioFindings],
    ["العلاج السابق", visit.previousTreatment], ["نتائج الأشعة المسجلة", visit.radiographicFindings],
    ["عدد القنوات المكتشفة", visit.canalsFound], ["التحضير", visit.instrumentation],
    ["الإرواء", visit.irrigation], ["الدواء داخل القناة", visit.medicament],
    ["تقنية حشو القنوات", visit.obturationTechnique], ["مادة الحشو", visit.obturationMaterial],
    ["الترميم بعد الجلسة", visit.restorationAfter ? RESTORATIVE_LABEL[visit.restorationAfter] : null],
    ["المضاعفات", visit.complications], ["الإنذار", visit.prognosis ? PROGNOSIS_LABEL[visit.prognosis] : null],
    ["الخطوة التالية", visit.nextStep], ["المراجعة بعد (أسابيع)", visit.nextVisitWeeks], ["ملاحظة", visit.note],
  ];
  return fields.filter((field): field is [string, string | number] => field[1] !== null && field[1] !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}

/** A clinical-only print projection of the existing patient records, never a second report/ledger source. */
export function projectDossierEndo(patientId: number, treatments: readonly EndoTreatmentView[]) {
  return treatments.filter((treatment) => treatment.patientId === patientId).map((treatment) => ({
    id: treatment.id, caseId: treatment.caseId, caseTitle: treatment.caseTitle,
    toothCode: treatment.toothCode, toothName: treatment.toothName,
    kind: ENDO_KIND_LABEL[treatment.kind], status: ENDO_STATUS_LABEL[treatment.status], outcome: treatment.outcome,
    visits: treatment.visits
      .filter((visit) => visit.treatmentId === treatment.id && (hasMeaningfulEndoRecord(visit) || (visit.signed && visit.addenda.length > 0)))
      .map((visit) => ({
        id: visit.id, visitId: visit.visitId, stage: ENDO_STAGE_LABEL[visit.stage], signed: visit.signed,
        doctorName: visit.doctorName, recordedBy: visit.recordedBy, recordedAt: visit.recordedAt, updatedAt: visit.updatedAt,
        details: clinicalDetails(visit),
        canals: visit.canals.map((canal) => ({
          label: canal.label, workingLengthMm: canal.workingLengthMm,
          reference: canal.referencePoint ? REFERENCE_POINT_LABEL[canal.referencePoint] : null,
          method: canal.measurementMethod ? MEASUREMENT_METHOD_LABEL[canal.measurementMethod] : null,
          masterApicalSize: canal.masterApicalSize, taperPercent: canal.taperPercent,
          instrumentation: canal.instrumentation, obturated: canal.obturated, note: canal.note,
        })),
        addenda: visit.addenda.map((addendum) => ({
          id: addendum.id, body: addendum.body, author: addendum.author, createdAt: addendum.createdAt,
        })),
      })),
  })).filter((treatment) => treatment.visits.length > 0);
}

const recordedTime = (value: string) => new Intl.DateTimeFormat("ar-YE", {
  timeZone: CLINIC_ZONE_FALLBACK, dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function PatientDossierEndo({ patientId, treatments }: {
  patientId: number;
  treatments: readonly EndoTreatmentView[] | null;
}) {
  const records = treatments === null ? null : projectDossierEndo(patientId, treatments);
  return <section style={{ margin: "4mm 0", fontSize: "8pt", overflowWrap: "anywhere" }} aria-label="سجل علاج الجذور">
    <h3 style={{ fontSize: "10pt", margin: "0 0 2mm" }}>سجل علاج الجذور</h3>
    {records === null ? <p role="alert">تعذّر تحميل سجلات علاج الجذور؛ هذا القسم غير مكتمل. أعد تحميل الملف قبل طباعته.</p>
      : records.length === 0 ? <p>لا توجد سجلات جلسات علاج جذور موثقة بالمحتوى السريري.</p>
      : records.map((treatment) => <section key={treatment.id} style={{ margin: "3mm 0", borderTop: "1px solid #cbd5e1" }}>
        <h4 style={{ margin: "2mm 0", breakAfter: "avoid" }}>
          السن {treatment.toothCode} — {treatment.toothName} · {treatment.kind} · {treatment.status}
        </h4>
        <p>الحالة #{treatment.caseId}: {treatment.caseTitle} · سجل علاج الجذور #{treatment.id}</p>
        {treatment.outcome ? <p><strong>نتيجة العلاج:</strong> {treatment.outcome}</p> : null}
        {treatment.visits.map((visit) => <section key={visit.id} style={{ margin: "3mm 0", padding: "2mm", border: "1px solid #e2e8f0" }}>
          <table className="dossier-endo-record" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead><tr><td style={{ padding: 0 }}>
          <h5 style={{ fontSize: "8.5pt", margin: "0 0 1mm", breakAfter: "avoid" }}>
            سجل الجلسة السريري #{visit.id} · زيارة #{visit.visitId} · {visit.stage} · {visit.signed ? "زيارة موقّعة" : "مسودة غير موقّعة"}
          </h5>
          <p dir="ltr" style={{ fontSize: "7pt", margin: "0 0 1mm", textAlign: "right" }}>
            Case #{treatment.caseId} · Tooth {treatment.toothCode} · Record #{visit.id} · Visit #{visit.visitId} · {visit.signed ? "Signed" : "Unsigned draft"}
          </p>
          <p>الطبيب: {visit.doctorName || "غير مسجّل"} · سُجّل بواسطة {visit.recordedBy} في {recordedTime(visit.recordedAt)}</p>
          {visit.updatedAt ? <p>آخر تعديل للسجل: {recordedTime(visit.updatedAt)}</p> : null}
          </td></tr></thead>
          <tbody><tr><td style={{ padding: 0 }}>
          <dl style={{ margin: "1mm 0" }}>{visit.details.map((detail) => <div key={detail.label} style={{ margin: "1mm 0", whiteSpace: "pre-wrap" }}>
            <dt style={{ display: "inline", fontWeight: 700 }}>{detail.label}: </dt><dd style={{ display: "inline", margin: 0 }}>{detail.value}</dd>
          </div>)}</dl>
          {visit.canals.length > 0 ? <table className="items report-table" style={{ width: "100%", fontSize: "7.5pt" }}>
            <thead><tr><th>القناة</th><th>الطول العامل / المرجع / القياس</th><th>التحضير</th><th>الحشو والملاحظات</th></tr></thead>
            <tbody>{visit.canals.map((canal, index) => <tr key={`${canal.label}-${index}`}>
              <td>{canal.label}</td>
              <td>{canal.workingLengthMm === null ? "طول غير مسجّل" : `${canal.workingLengthMm} مم`} · {canal.reference || "مرجع غير مسجّل"} · {canal.method || "طريقة غير مسجّلة"}</td>
              <td>مقاس: {canal.masterApicalSize ?? "—"} · تدرج: {canal.taperPercent === null ? "—" : `${canal.taperPercent}%`}{canal.instrumentation ? ` · ${canal.instrumentation}` : ""}</td>
              <td>{canal.obturated ? "حشو موثّق" : "لا يوجد حشو موثّق"}{canal.note ? ` · ${canal.note}` : ""}</td>
            </tr>)}</tbody>
          </table> : null}
          {visit.addenda.map((addendum) => <div key={addendum.id} style={{ marginTop: "2mm", padding: "2mm", borderRight: "2px solid #64748b", breakInside: "avoid" }}>
            <strong>ملحق #{addendum.id} للسجل السريري الموقّع #{visit.id} · {addendum.author} · {recordedTime(addendum.createdAt)}</strong>
            <p style={{ margin: "1mm 0", whiteSpace: "pre-wrap" }}>{addendum.body}</p>
          </div>)}
          </td></tr></tbody>
          </table>
        </section>)}
      </section>)}
  </section>;
}
