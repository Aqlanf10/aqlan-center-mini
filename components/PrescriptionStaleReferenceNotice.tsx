import { isDoseReferenceAcceptedForNewIssue } from '@/lib/medication-dose-compatibility';
import type { RxItem } from '@/lib/prescription';
export function PrescriptionStaleReferenceNotice({item,onRetire}:{item:RxItem;onRetire:()=>void}) {
 if(!item.selection?.doseReview || isDoseReferenceAcceptedForNewIssue(item.selection.doseReview.profileId,item.selection.doseReview.referenceVersion))return null;
 return <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3 text-xs">
  <p>تغير إصدار المرجع. بقي نص السطر كما كتبته؛ لا يمكن إصداره مع المرجع القديم. أعد اختيار المرجع الحالي من القسم الاختياري، أو راجع النص كإدخال يدوي مستقل دون ادعاء اعتماد المرجع السابق.</p>
  <button type="button" className="mt-2 rounded border bg-white px-3 py-2" onClick={onRetire}>الاحتفاظ بالنص وإعادة مراجعته كإدخال يدوي</button>
 </div>;
}
