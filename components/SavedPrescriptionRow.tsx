import type { RxItem } from "@/lib/prescription";
export type SavedRx = {
  id: number; visitId: number | null; createdAt: string; prescribingDoctorName: string | null;
  status?: "active" | "void"; items?: RxItem[]; voidReason?: string | null;
  createdAtLabel?: string; timeZone?: string;
};
/** Read-only issued snapshot. Status is not evidence of pharmacy dispensing. */
export function SavedPrescriptionRow({ rx, patientId }: { rx: SavedRx; patientId: number }) {
  return <li className="my-3 border-t pt-3">
    <div className="flex flex-wrap items-center gap-3">
      <span>وصفة #{rx.id} — <time dateTime={rx.createdAt} title={rx.timeZone}><bdi>{rx.createdAtLabel || rx.createdAt.slice(0, 10)}</bdi></time> — {rx.prescribingDoctorName || "اسم الطبيب غير موثق في السجل القديم"}</span>
      <span>{rx.visitId ? `زيارة #${rx.visitId}` : "دون ربط موثق بزيارة"}</span>
      {rx.status && <strong className={rx.status === "void" ? "text-red-700" : "text-emerald-800"}>{rx.status === "void" ? "مبطلة" : "مصدرة"}</strong>}
      {rx.status !== "void" && <a className="rounded border px-3 py-2 font-bold" href={`/print/prescription/${patientId}?rx=${rx.id}`} target="_blank" rel="noopener noreferrer">فتح الوصفة للطباعة</a>}
    </div>
    {rx.status === "void" && <p className="my-2 text-sm text-red-700">لا تعاد طباعة هذه الوصفة. {rx.voidReason ? `سبب الإبطال: ${rx.voidReason}` : "سبب الإبطال غير موثق في السجل القديم."}</p>}
    {rx.items && <ul className="mt-2 space-y-2" aria-label="الأدوية والتعليمات المحفوظة">{rx.items.map((item, index) => <li key={index} className="rounded bg-slate-50 p-2 text-sm">
      <p dir="ltr" className="text-left"><bdi dir="ltr"><strong>{item.name}</strong>{[item.dose, item.form, item.frequency, item.duration].filter(Boolean).map((value, i) => <span key={i}> — {value}</span>)}</bdi></p>
      {item.selection?.amount && <p dir="ltr" className="mt-1 text-left"><bdi dir="ltr">Dose: {item.selection.amount}</bdi></p>}
      {item.instructions && <p dir="rtl" className="mt-1 whitespace-pre-wrap text-right"><bdi dir="auto">{item.instructions}</bdi></p>}
      {item.instructionsEn && <p dir="ltr" className="mt-1 whitespace-pre-wrap text-left"><bdi dir="ltr">{item.instructionsEn}</bdi></p>}
    </li>)}</ul>}
    {rx.items?.length === 0 && <p className="my-2 text-sm text-slate-600">تفاصيل الأدوية غير موثقة في السجل القديم؛ لا تُستنتج تعليمات بديلة.</p>}
  </li>;
}
