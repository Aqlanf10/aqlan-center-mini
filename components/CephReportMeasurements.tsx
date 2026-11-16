import { PrintTableFrame } from "@/components/PrintDocument";
import { cephReportLayout, cephReportReference, cephReportValue, type CephReportRow } from "@/lib/ceph-report-layout";

/** Full-width clinical reading. Sources are indexed, never silently replaced.
 * No stars, invented interpretation or current-registry enrichment of archives. */
export function CephReportMeasurements({ rows, completed, contextLabel }: { rows: readonly CephReportRow[]; completed: boolean; contextLabel: string }) {
  const layout = cephReportLayout(rows);
  return <section className="ceph-measurements" aria-label="جداول القياسات السيفالومترية" data-testid="ceph-report-measurements">
    <h2>{completed ? "القياسات المحفوظة عند الاعتماد" : "قياسات المسودة"}<span dir="ltr">Cephalometric measurements</span></h2>
    <p className="ceph-small">قيم متاحة: {layout.available} / {layout.total} · غير متاحة: {layout.unavailable}. هذا جرد للقيم، لا شهادة اكتمال أو دقة سريرية.</p>
    <p className="ceph-small">أرقام المراجع معلومات مصدرية؛ لا تُحوّل هنا إلى حكم طبيعي أو شدة أو خطة علاج. الرمز — يعني غير متاح، وليس صفرًا أو طبيعيًا.</p>
    {layout.groups.length === 0 && <p role="note">لا توجد قياسات متاحة في هذا السجل.</p>}
    {layout.groups.map(group => <section key={group.id} className="ceph-measurement-group" data-group={group.id}>
      <h3>{group.ar}<span dir="ltr">{group.en}</span></h3>
      <PrintTableFrame><table className="ceph-clinical-table">
        <thead><tr><th className="ceph-table-context" colSpan={4}>{contextLabel}</th></tr><tr><th scope="col">القياس / Parameter</th><th scope="col">القيمة / Value</th><th scope="col">أرقام المرجع / Catalog</th><th scope="col">المصدر / Source</th></tr></thead>
        <tbody>{group.rows.map(row => <tr key={row.code} data-measurement={row.code}>
          <td><b>{row.code}</b>{row.en !== row.code && <span className="ceph-measurement-name" dir="ltr">{row.en}</span>}
            {row.ar !== row.code && row.ar !== row.en && <span className="ceph-measurement-name">{row.ar}</span>}</td>
          <td className="ceph-numeric"><bdi>{cephReportValue(row)}</bdi></td>
          <td className="ceph-numeric"><bdi>{cephReportReference(row)}</bdi></td>
          <td className="ceph-source-number"><bdi>[{layout.sources.indexOf(row.source) + 1}]</bdi></td>
        </tr>)}</tbody>
      </table></PrintTableFrame>
    </section>)}
    <section className="ceph-reference-list" aria-label="مصادر أرقام المراجع">
      <h3>مصادر أرقام المراجع</h3>
      {layout.sources.map((source, index) => <p key={source}><bdi>[{index + 1}]</bdi> {source || "المصدر غير موثّق"}</p>)}
      <p>توافق التعريف والوحدة وملاءمة المرجع للمريض يحتاج مراجعة الطبيب. تفاصيل الحساب والسجل في ملحق التدقيق.</p>
    </section>
  </section>;
}
