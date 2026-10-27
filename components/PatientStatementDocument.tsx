import type { PatientStatementDocument as StatementDocument } from "@/lib/patient-statement-document";
import { SETTING_DEFAULTS } from "@/lib/settings";
import { PrintFooter, PrintHeader } from "./PrintHeader";

/** Only patient-facing text is rendered; selection and recipient metadata stays outside the sheet. */
export function PatientStatementDocument({ document }: { document: StatementDocument }) {
  const settings = {
    ...SETTING_DEFAULTS,
    "clinic.name": document.clinic.name,
    "clinic.lead_doctor": document.clinic.doctor ?? "",
    "clinic.lead_doctor_title": "",
    "clinic.lead_doctor_credentials": document.clinic.credentials ?? "",
    "clinic.address": document.clinic.address ?? "",
    "clinic.phone": document.clinic.phone ?? "",
  };
  return <article className="patient-statement-document sheet sheet-a4" dir="rtl" aria-label="معاينة كشف حساب المريض">
    <style>{`
      .patient-statement-document { background:white;color:#0d2137;padding:24px;max-width:100%;font-size:14px;line-height:1.8; }
      .patient-statement-document .print-logo { width:60px;height:52px;margin:0 auto; }
      .patient-statement-document .clinic-name {font-size:20px;font-weight:700;}
      .patient-statement-document .clinic-sub,.patient-statement-document .footer-note {font-size:12px;color:#475569;}
      .patient-statement-document .doc-title {font-size:21px;font-weight:700;margin:12px 0;}
      .patient-statement-document .rule {border-top:2px solid #f47727;margin:12px 0;}
      .patient-statement-document .rule-light {border-top:1px solid #cbd5e1;margin:16px 0 8px;}
      .patient-statement-document h3 {font-weight:700;font-size:16px;margin:20px 0 8px;}
      .patient-statement-document table {width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;}
      .patient-statement-document th,.patient-statement-document td {text-align:right;vertical-align:top;border:1px solid #cbd5e1;padding:8px;overflow-wrap:anywhere;white-space:pre-wrap;}
      .patient-statement-document th {background:#f1f5f9;font-weight:700;}
      .patient-statement-document .statement-identity {display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;}
      .patient-statement-document .statement-notice {font-size:12px;margin:12px 0;}
      @media(max-width:480px){.patient-statement-document {padding:12px;}.patient-statement-document th,.patient-statement-document td {padding:5px;font-size:11px;}}
      @media print { .patient-statement-document {max-width:none;padding:0;font-size:11pt;} .patient-statement-document thead {display:table-header-group;} .patient-statement-document tr {break-inside:avoid;} .patient-statement-document h3 {break-after:avoid;} .patient-statement-document footer {break-inside:avoid;} }
    `}</style>
    <PrintHeader settings={settings} title={document.title} />
    {document.subtitle ? <p>{document.subtitle}</p> : null}
    <div className="statement-identity"><p>المريض: <strong>{document.patient.name}</strong></p><p>رقم الملف: <bdi>{document.patient.number}</bdi></p></div>
    <p className="footer-note">تاريخ الإصدار: <bdi>{document.generatedAt}</bdi></p>
    {document.sections.map((section, index) => <section key={index}>
      <h3>{section.title}</h3>
      <table><thead><tr>{section.columns.map((column, i) => <th key={i} scope="col">{column}</th>)}</tr></thead>
        <tbody>{section.rows.length ? section.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>) : <tr><td colSpan={section.columns.length}>لا توجد حركات</td></tr>}</tbody>
      </table>
    </section>)}
    {document.notices.map((notice, i) => <p className="statement-notice" key={i}>{notice}</p>)}
    <footer><PrintFooter settings={settings} /></footer>
  </article>;
}
