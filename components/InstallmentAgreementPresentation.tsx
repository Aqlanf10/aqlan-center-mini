import { formatMoney, type Currency } from "@/lib/money";
import { Logo } from "./Icon";
import { friendlyDateLong } from "@/lib/reminders";

/** Official agreement identity shared by treatment plans and saved invoice schedules.
 * Presentation only: callers retain their own verified financial provenance. */
export function AgreementFinancialSummary({ totalLabel, remainingLabel, totalMinor, paidMinor, remainingMinor, currency, testId }: {
  totalLabel: string; remainingLabel: string; totalMinor: number; paidMinor: number; remainingMinor: number; currency: Currency; testId?: string;
}) {
  return <div data-testid={testId} className="agreement-financial-summary">
    <div className="line line-strong"><span>{totalLabel}</span><span className="num">{formatMoney(totalMinor, currency)}</span></div>
    <div className="line" style={{ color: "#059669", fontWeight: 700 }}><span>المسدد حتى تاريخه</span><span className="num">{formatMoney(paidMinor, currency)}</span></div>
    <div className="line" style={{ color: "#b91c1c", fontWeight: 700 }}><span>{remainingLabel}</span><span className="num">{formatMoney(remainingMinor, currency)}</span></div>
  </div>;
}

/** Three paired rows retain identity and actual cumulative financial evidence together. */
export function AgreementIdentitySummary({ patientName, patientNumber, reference, totalLabel, totalMinor, paidMinor, remainingMinor, currency }: {
  patientName: string; patientNumber: string; reference: string; totalLabel: string;
  totalMinor: number; paidMinor: number; remainingMinor: number; currency: Currency;
}) {
  return <div className="agreement-financial-summary agreement-identity-summary" data-testid="saved-agreement-financial-summary">
    <div className="agreement-summary-row"><div><span>المريض</span><strong>{patientName}</strong></div><div><span>رقم الملف</span><strong>{patientNumber}</strong></div></div>
    <div className="agreement-summary-row"><div><span>مرجع الاتفاق</span><strong>{reference}</strong></div><div><span>{totalLabel}</span><span className="num">{formatMoney(totalMinor, currency)}</span></div></div>
    <div className="agreement-summary-row"><div><span>المسدد حتى تاريخه</span><span className="num">{formatMoney(paidMinor, currency)}</span></div><div><span>المتبقي للسداد</span><span className="num">{formatMoney(remainingMinor, currency)}</span></div></div>
  </div>;
}

/** Bounded whitespace profiles, not scaling or truncating financial content. */
export function agreementDensity(count: number): "relaxed" | "balanced" | "dense" {
  return count <= 12 ? "relaxed" : count <= 24 ? "balanced" : "dense";
}

export type AgreementInstallmentRow = {
  key: string | number; number: string | number; dueDate: string; amountMinor: number; paid: boolean;
  /** Verified settlement detail for invoice schedules; never infer payment from a proposal. */
  settledMinor?: number; remainingMinor?: number;
};

export function AgreementInstallmentTable({ rows, currency }: { rows: AgreementInstallmentRow[]; currency: Currency }) {
  return <div className="agreement-schedule-table" data-density={agreementDensity(rows.length)}>
    <div className="agreement-table-watermark" aria-hidden="true"><Logo /></div>
    <table className="items agreement-installments" style={{ width: "100%", borderCollapse: "collapse" }}>
    <thead><tr>
      <th style={{ textAlign: "center", width: "15%" }}>القسط</th>
      <th style={{ textAlign: "right", width: "22%" }}>تاريخ الاستحقاق</th>
      <th className="num" style={{ width: "16%" }}>المبلغ</th>
      <th className="num" style={{ width: "16%" }}>المحصّل</th>
      <th className="num" style={{ width: "16%" }}>المتبقي</th>
      <th style={{ textAlign: "center", width: "15%" }}>حالة السداد</th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.key} style={{ background: row.paid ? "#f0fdf4" : "transparent" }}>
      <td style={{ textAlign: "center", fontWeight: 700 }}>{row.number}</td>
      <td style={{ textAlign: "right" }}>{friendlyDateLong(row.dueDate)}</td>
      <td className="num">{formatMoney(row.amountMinor, currency)}</td>
      <td className="num">{row.settledMinor === undefined ? "—" : formatMoney(row.settledMinor, currency)}</td>
      <td className="num">{row.remainingMinor === undefined ? "—" : formatMoney(row.remainingMinor, currency)}</td>
      <td style={{ textAlign: "center", fontWeight: 700, color: row.paid ? "#15803d" : "#b45309" }}>
        {row.paid ? "مسدد ✓" : (row.settledMinor ?? 0) > 0 ? "مسدد جزئيًا" : "مستحق"}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

export function AgreementTermsAndSignatures({ terms, note }: { terms: string[]; note?: string | null }) {
  return <section className="agreement-closing">
    <div className="rule-light" style={{ margin: "2mm 0" }} />
    <h3 style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>الشروط والالتزامات السريرية:</h3>
    <ol style={{ paddingRight: "5mm", margin: "2mm 0", fontSize: "8.5pt", lineHeight: "1.35", color: "#334155" }}>
      {terms.map((term, i) => <li key={i} style={{ marginBottom: "0.5mm" }}>{term}</li>)}
    </ol>
    {note ? <p className="footer-note" style={{ fontSize: "8.5pt", margin: "2mm 0" }}><strong>ملاحظات سريرية خاصة:</strong> {note}</p> : null}
    <div className="sign-row agreement-signatures" style={{ marginTop: "4mm", display: "flex", justifyContent: "space-between" }}>
      <div style={{ textAlign: "center", width: "40%" }}>
        <p style={{ fontWeight: 700, fontSize: "10pt" }}>الطبيب المعالج / إدارة المركز</p>
        <div style={{ height: "10mm", borderBottom: "1px dashed #94a3b8" }} />
        <p style={{ fontSize: "8pt", color: "#64748b", marginTop: "1mm" }}>الختم والتوقيع</p>
      </div>
      <div style={{ textAlign: "center", width: "40%" }}>
        <p style={{ fontWeight: 700, fontSize: "10pt" }}>إقرار وموافقة المريض (أو ولي أمره)</p>
        <div style={{ height: "10mm", borderBottom: "1px dashed #94a3b8" }} />
        <p style={{ fontSize: "8pt", color: "#64748b", marginTop: "1mm" }}>التوقيع والاسم الثلاثي</p>
      </div>
    </div>
  </section>;
}
