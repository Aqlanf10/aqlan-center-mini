"use client";
import {formatMoney} from "@/lib/money";
import {CLINIC_ZONE_FALLBACK} from "@/lib/clinicZone";
import {SIMILAR_COLLECTION_WINDOW_HOURS,type SimilarCollectionReceipt} from "@/lib/similar-collection";

/**
 * Advisory only. The server proved nothing was written for this attempt and reported the
 * similar receipts it found under the cashier-shift lock. Cancelling never touches a recorded
 * receipt; continuing records an independent payment with the SAME request and key.
 */
export function SimilarCollectionWarning({receipts,busy,onConfirm,onCancel}:{
  receipts:readonly SimilarCollectionReceipt[];busy:boolean;onConfirm:()=>void;onCancel:()=>void;
}){
  const none=receipts.length===0;
  return <section role="alertdialog" aria-label="تنبيه سند قبض مشابه" data-testid="similar-collection-warning" dir="rtl"
    className="mb-3 space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm">
    <h4 className="font-extrabold text-amber-900">⚠️ {none?"تغيّرت السندات المشابهة منذ المراجعة":"يوجد سند قبض مشابه"}</h4>
    <p className="text-slate-700">{none
      ?"لم تعد هناك سندات بالمبلغ والعملة نفسيهما خلال آخر 24 ساعة. لم يُسجَّل شيء بعد؛ تابع إن كان التحصيل مقصودًا."
      :`سُجّل لهذا المريض تحصيل بالمبلغ والعملة نفسيهما خلال آخر ${SIMILAR_COLLECTION_WINDOW_HOURS} ساعة. لم يُسجَّل شيء بعد. تأكد أن المبلغ لم يُحصَّل سابقًا.`}</p>
    {receipts.slice(0,6).map(r=><div key={r.id} className="rounded-lg border border-amber-200 bg-white p-2">
      {r.allocations
        ?<p className="font-extrabold">عملية تحصيل واحدة موزعة على {r.allocations.length} سندات · إجمالي المدفوع {formatMoney(r.amountMinor,r.currency)}</p>
        :<p className="font-extrabold">السند {r.receiptNumber} · {formatMoney(r.amountMinor,r.currency)}</p>}
      <p>الوقت: {new Date(r.createdAt).toLocaleString("ar-YE",{timeZone:CLINIC_ZONE_FALLBACK})}</p>
      <p>الطريقة: {r.method==="transfer"?"تحويل":"نقدًا"}{r.allocations?"":r.invoiceId?` · الفاتورة #${r.invoiceId}`:r.planId?` · الخطة #${r.planId}`:""} · الموظف: {r.createdBy}</p>
      {r.allocations
        // Each receipt keeps its own amount and link; the operation total is never attributed to one receipt.
        ?<ul className="mt-1 space-y-1" aria-label="سندات العملية">{r.allocations.map(a=><li key={a.id}>
          السند {a.receiptNumber} · {formatMoney(a.amountMinor,r.currency)}{a.invoiceId?` · الفاتورة #${a.invoiceId}`:""}
          {a.refundedMinor>0?` · مسترد ${formatMoney(a.refundedMinor,r.currency)}${a.refundedMinor===a.amountMinor?" (بالكامل)":""}`:""}
          {" "}<a href={`/print/receipt/${a.id}`} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-800 underline">مراجعة السند {a.receiptNumber}</a>
        </li>)}</ul>
        :<a href={`/print/receipt/${r.id}`} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-800 underline">مراجعة السند</a>}
    </div>)}
    {receipts.length>6?<p className="text-xs text-amber-900">توجد سندات مشابهة أخرى؛ راجع كشف الحساب.</p>:null}
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={onCancel} className="flex-1 rounded-lg border border-slate-300 bg-white p-2 font-bold disabled:opacity-50">إلغاء التحصيل</button>
      <button type="button" disabled={busy} onClick={onConfirm} className="flex-1 rounded-lg bg-amber-600 p-2 font-bold text-white disabled:opacity-50">{none?"متابعة التحصيل":"تسجيل دفعة مستقلة"}</button>
    </div>
  </section>;
}
