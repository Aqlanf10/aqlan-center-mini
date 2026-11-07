"use client";
export function OrthoStudyPrintButton() {
  return <button type="button" className="print:hidden rounded border px-4 py-2" onClick={() => window.print()}>طباعة / حفظ PDF</button>;
}
