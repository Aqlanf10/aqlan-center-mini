/** Scoped print styles; leaves clinic branding and watermark components intact. */
export function CephReportStyle() {
  return <style>{`
.ceph-clinical-report { --ceph-accent:#0284a8; color:#172b3a; direction:rtl; font-size:10pt; line-height:1.65; }
.ceph-clinical-report * { box-sizing:border-box; }
.ceph-clinical-report h2 { margin:6mm 0 3mm; padding:2mm 3mm; border-right:4px solid var(--ceph-accent); background:#eff9fc; font-size:13pt; line-height:1.5; break-after:avoid; }
.ceph-clinical-report h2>span,.ceph-clinical-report h3>span { display:block; font-size:9pt; font-weight:400; color:#486273; }
.ceph-clinical-report h3 { font-size:11pt; margin:4mm 0 2mm; break-after:avoid; }
.ceph-clinical-report .ceph-small { font-size:8.5pt; color:#425969; line-height:1.7; margin:2mm 0; }
.ceph-clinical-report .ceph-status { border:1px solid #9acbdb; background:#f5fbfd; border-radius:2mm; padding:2.5mm 3mm; margin:3mm 0; }
.ceph-clinical-report .ceph-status strong { display:block; font-size:11pt; }
.ceph-clinical-report .ceph-measurement-group { margin:4mm 0; break-inside:avoid; }
.ceph-clinical-report .ceph-clinical-table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:9pt; line-height:1.35; }
.ceph-clinical-report .ceph-clinical-table th { background:#eff6fa; font-size:8.5pt; border-bottom:1px solid #7da8bc; text-align:right; padding:2mm; }
.ceph-clinical-report .ceph-clinical-table th:first-child { width:48%; }
.ceph-clinical-report .ceph-clinical-table th:nth-child(2) { width:18%; }
.ceph-clinical-report .ceph-clinical-table th:nth-child(3) { width:24%; }
.ceph-clinical-report .ceph-clinical-table th:last-child { width:10%; }
.ceph-clinical-report .ceph-clinical-table th.ceph-table-context { width:auto; background:white; color:#486273; font-size:8pt; font-weight:400; border-bottom:0; }
.ceph-clinical-report .ceph-clinical-table td { padding:1.2mm 2mm; border-bottom:1px solid #dbe5eb; vertical-align:top; overflow-wrap:anywhere; }
.ceph-clinical-report .ceph-clinical-table tr { break-inside:avoid; }
.ceph-clinical-report .ceph-measurement-name { display:block; font-size:8pt; color:#486273; }
.ceph-clinical-report .ceph-numeric { text-align:center; font-variant-numeric:tabular-nums; }
.ceph-clinical-report .ceph-source-number { text-align:center; }
.ceph-clinical-report .ceph-reference-list { font-size:8pt; overflow-wrap:anywhere; }
.ceph-clinical-report .ceph-reference-list p { margin:1mm 0; }
.ceph-clinical-report .ceph-notes { white-space:pre-wrap; overflow-wrap:anywhere; padding:3mm; background:#f8fbfc; border:1px solid #dbe5eb; margin:2mm 0 4mm; }
.ceph-clinical-report .ceph-audit { margin-top:6mm; border-top:1px solid #a6bac5; padding-top:3mm; font-size:8pt; overflow-wrap:anywhere; }
.ceph-clinical-report .ceph-audit summary { cursor:pointer; font-weight:bold; padding:2mm; }
.ceph-clinical-report .ceph-audit-entry { border-bottom:1px solid #dbe5eb; padding:2mm 0; break-inside:avoid; }
.ceph-clinical-report .ceph-audit-entry p { margin:1mm 0; }
@page ceph-report { size:A4; margin:12mm; @bottom-center { content:counter(page) " / " counter(pages); font-family:Arial,sans-serif; font-size:8pt; color:#486273; } }
@media print {
.ceph-clinical-report { page:ceph-report; print-color-adjust:exact; -webkit-print-color-adjust:exact; }
.ceph-clinical-report .ceph-measurements,.ceph-clinical-report .ceph-diagnosis { break-before:page; }
.ceph-clinical-report .ceph-clinical-table thead { display:table-header-group; }
.ceph-clinical-report .ceph-audit[open] { break-before:page; }
.ceph-clinical-report .ceph-audit:not([open]) { display:none; }
.ceph-clinical-report .ceph-signature { break-inside:avoid; }
}
`}</style>;
}
