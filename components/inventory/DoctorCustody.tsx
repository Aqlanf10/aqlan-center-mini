"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
import { ArrowLeftRight,ClipboardCheck,RefreshCw,ShieldCheck } from "lucide-react";
import { useSession,type SessionInfo } from "@/components/SessionProvider";
import { inventoryCan } from "@/lib/inventory-ui-access";
import { ReportPrintHeader } from "@/components/ReportPrintHeader";
import { formatMoney } from "@/lib/money";
import { custodyUsageQuantity } from "@/lib/inventory-domain/presentation";
import type { readDoctorCustody,CustodyDispatch } from "@/lib/inventory-domain/custody-store";
import { useInventoryCommand } from "./useInventoryCommand";
import { inventoryRecoveryEnglish } from "@/lib/inventory-command-recovery";
import styles from "./inventory.module.css";
const english:Record<string,string>={
 "اعتماد التالف (مستقل عن طبيب العهدة)":"Waste approval (independent of the custody doctor)","موقع العهدة للتالف":"Custody location for waste","دفعة التالف":"Waste lot",
 "الحد الأقصى للكمية التالفة":"Maximum waste quantity","سبب الاعتماد":"Approval reason","سبب اعتماد التالف":"Waste approval reason","اعتماد التالف":"Approve waste","رقم الاعتماد:":"Approval ID:",
 "الاعتماد حدٌّ أقصى فقط؛ لا يخصم شيئًا حتى يسجّل الطبيب التالف الفعلي برقم الاعتماد. لا أثر مالي تلقائي.":"The approval is only a ceiling; nothing is deducted until the doctor records the actual waste with this approval ID. No automatic financial effect.",
 "اختر موقع العهدة والدفعة، واكتب الحد الأقصى للتالف وسبب الاعتماد.":"Choose the custody location and lot, then enter the maximum waste and the approval reason.",
 "تم اعتماد التالف بحد أقصى. انسخ رقم الاعتماد للطبيب لتسجيل التالف الفعلي.":"Waste approved up to a ceiling. Give the approval ID to the doctor to record the actual waste.",
 "موقع العهدة":"Custody location","الدفعة":"Lot",
 ...inventoryRecoveryEnglish,
 "عهد المواد للأطباء": "Doctor material custody",
 "المخزن · قيد النقل · عهدة الطبيب": "Store · In transit · Doctor custody",
 "المخزون": "Inventory",
 "طلبات شراء المواد": "Purchase requests",
 "تحديث": "Refresh",
 "جارٍ تحميل العهد…": "Loading custody…",
 "مواد العهدة تبقى ملكًا للمركز. الاستهلاك يسجل مستقلًا بمصدره. فروق الجرد والتسوية تحتاج مراجعة واعتمادًا؛ لا ينشأ خصم راتب أو دين تلقائي.": "Custody materials remain clinic property. Consumption is recorded separately with its source. Count differences and settlement require review and approval; no wage deduction or debt is created automatically.",
 "عهدة طبيب": "Doctor custody",
 "قيد النقل": "In transit",
 "مخزن المركز": "Clinic store",
 "صالح متاح": "Valid and available",
 "غير متاح للصرف": "Unavailable for issue",
 "المتاح للصرف:": "Available for issue:",
 "قيد الحجر:": "Held in quarantine:",
 "غير معروف": "Unknown",
 "لا تنطبق / غير مؤكدة": "Not applicable / unconfirmed",
 "تقدير العرض الأصلي:": "Original quote estimate:",
 "تكلفة تقديرية": "Estimated cost",
 "التتبع يحتاج مراجعة": "Tracking requires review",
 "لا توجد كمية مخصصة لهذا الموقع.": "No quantity is allocated to this location.",
 "تسليم عهدة / تحويل مادة": "Dispatch / transfer material",
 "المصدر": "Source",
 "العهدة / الوجهة": "Custody / destination",
 "موقع قيد النقل": "Transit location",
 "الدفعة الصالحة": "Valid lot",
 "اختر الموقع": "Select location",
 "اختر الوجهة": "Select destination",
 "اختر موقع قيد النقل": "Select transit location",
 "اختر دفعة": "Select lot",
 "كمية التحويل": "Transfer quantity",
 "سبب التسليم / التحويل": "Dispatch / transfer reason",
 "إرسال المادة إلى قيد النقل": "Dispatch material into transit",
 "تحويلات تنتظر إثبات الاستلام": "Transfers awaiting receipt",
 "المقبول الآن": "Accepted now",
 "الراجع للمصدر": "Returned to source",
 "نتيجة العد / سبب الفرق": "Count result / difference reason",
 "تأكيد الكميات المستلمة": "Confirm received quantities",
 "لا توجد تحويلات معلقة في هذا النطاق.": "No pending transfers in this scope.",
 "السابق": "Previous",
 "التالي": "Next",
 "صفحة": "Page",
 "تسليم العبوات الفارغة يخص العبوات الآمنة فقط. الأدوات الحادة والمواد الملوثة توثق إجراءات التخلص الآمن منها؛ لا تعاد للمخزن ولا تستخرج من النفايات للعد أو التصوير.": "Empty package returns apply only to safe packages. Sharps and contaminated materials need documented safe disposal; never return them to storage or retrieve them from waste for counting or photographs.",
 "إعادة تأكيد العملية نفسها": "Confirm the same operation again",
 "تم حفظ التحويل وإثباته. الكمية والقيمة تبقيان ضمن مخزون المركز.": "Transfer recorded. Quantity and value remain in clinic inventory.",
 "اختر المصدر والعهدة وقيد النقل والدفعة، واكتب الكمية والسبب.": "Choose source, destination, transit and lot; enter quantity and reason.",
 "اكتب نتيجة العد وسبب أي فرق قبل تأكيد الاستلام.": "Record the counted result and any difference before confirming receipt.",
 "تعذّر تحميل العهد.": "Custody is unavailable. Please refresh.",
 "تعذّر تأكيد النتيجة. أعد تأكيد العملية نفسها؛ تبقى المدخلات محفوظة حتى تتأكد النتيجة.": "The result could not be confirmed. Confirm the same operation again; inputs stay preserved until the result is known.",
 "لم تُقبل العملية. راجع المدخلات والصلاحية.": "The operation was refused. Check inputs and permission.",
 "تسوية الحركات التاريخية غير المخصصة": "Reconcile Unallocated Historical Movements",
 "المادة التي تحتاج تسوية تتبع": "Item requiring tracking reconciliation",
 "اختر المادة": "Select item",
 "مخزن التخصيص الافتراضي": "Default allocation store",
 "اختر المخزن": "Select store",
 "سبب التسوية التاريخية": "Historical reconciliation reason",
 "تخصيص الحركات التاريخية دون مضاعفة الرصيد": "Allocate historical movements without duplicating balance",
 "اختر المادة والمخزن واكتب سبب التسوية التاريخية.": "Select item, store, and enter the historical reconciliation reason.",
 "تسجيل استهلاك فعلي أو إرجاع للمخزن": "Record Actual Consumption or Store Return",
 "نوع حركة العهدة": "Custody movement kind",
 "استهلاك فعلي للمريض / الإجراء": "Actual patient / procedure consumption",
 "تالف معتمد من العهدة": "Approved custody waste",
 "إرجاع مادة صالحة غير مستخدمة للمخزن": "Return unused valid material to store",
 "حالة الكمية": "Quantity state",
 "مؤكدة فعليًا": "Confirmed actual",
 "تقديرية": "Estimated",
 "معرف المريض (اختياري)": "Patient ID (optional)",
 "معرف الزيارة (اختياري)": "Visit ID (optional)",
 "معرف الإجراء (اختياري)": "Procedure ID (optional)",
 "مرجع اعتماد التالف": "Waste approval reference",
 "مخزن الإرجاع": "Return store location",
 "حفظ حركة العهدة": "Save custody movement",
 "اختر موقع العهدة والدفعة والكمية والسبب قبل الحفظ.": "Select custody location, lot, quantity, and reason before saving.",
 "جرد العهدة وإثبات العبوات الفارغة / التخلص الآمن": "Custody Stocktake & Safe Package / Disposal Evidence",
 "الكمية الفعلية المعدودة": "Counted physical quantity",
 "سبب الجرد / ملاحظة المطابقة": "Stocktake reason / reconciliation note",
 "تسجيل نتيجة الجرد للمراجعة": "Record stocktake for review",
 "معرف العبوة الفريد": "Unique package ID",
 "معرف واقعة الإثبات": "Evidence event ID",
 "تصنيف الخطورة": "Hazard classification",
 "آمنة غير ملوثة": "Safe non-hazardous",
 "أداة حادة": "Sharp instrument",
 "ملوثة طبيًا": "Medically contaminated",
 "سياسة إثبات العبوة": "Package evidence policy",
 "إرجاع عبوة فارغة آمنة": "Safe empty package return",
 "توثيق تخلص آمن": "Safe disposal record",
 "عدّ وقياس سائب": "Bulk measure and count",
 "عهدة قابلة لإعادة الاستخدام": "Reusable custody",
 "كمية العبوة الأصلية": "Original package quantity",
 "المستهلك المسجل": "Recorded consumed quantity",
 "المرتجع / المحول": "Returned / transferred quantity",
 "التالف المعتمد": "Approved waste quantity",
 "المتبقي بالعبوة": "Remaining in package",
 "توثيق إغلاق العبوة / التخلص الآمن": "Record package closure / safe disposal",
 "المقارنة السنوية بين استهلاك العهدة ومخصص إهلاك المواد": "Annual Comparison: Custody Consumption vs Material Allowance",
 "المقارنة السنوية للمراجعة والاعتماد فقط؛ لا تنشئ مديونية أو خصم راتب أو سندًا ماليًا تلقائيًا.": "Annual comparison is for review and approval only; it creates no automatic debt, wage deduction, or cash voucher.",
 "طبيب العهدة": "Custody doctor",
 "الفترة / السنة": "Period / year",
 "العملة": "Currency",
 "المخصوم الفعلي للمواد (بالوحدات الصغرى)": "Actual applied material deductions (minor units)",
 "تكلفة الاستهلاك المنسوب للعهدة (بالوحدات الصغرى)": "Attributable custody consumption cost (minor units)",
 "سبب وملاحظات المقارنة السنوية": "Annual comparison reason & notes",
 "إصدار مقترح المقارنة السنوية للمراجعة": "Create annual comparison proposal for review",
 "تسجيل اعتراض الطبيب للمراجعة": "Submit doctor objection for review",
 "سبب الاعتراض": "Objection reason",
 "لصالح الطبيب (مقترح)": "Due to doctor (proposed)",
 "على الطبيب (مقترح للمراجعة)": "Proposed from doctor (for review)",
 "متوازن": "Balanced",
 "غير محسوم (بانتظار استكمال التتبع)": "Undetermined (awaiting tracking completion)",
 "جاهز للمراجعة المعتمدة": "Ready for authorized review",
 "مؤقت بانتظار الاستكمال": "Provisional awaiting completion",
 "معترض عليه قيد المراجعة": "Objected — under review",
 "موقع العهدة للاستهلاك أو الإرجاع": "Custody location for usage or return",
 "دفعة العهدة للاستهلاك أو الإرجاع": "Custody lot for usage or return",
 "كمية الاستهلاك أو الإرجاع": "Usage or return quantity",
 "سبب الاستهلاك أو الإرجاع": "Usage or return reason",
 "موقع العهدة للجرد": "Custody location for stocktake",
 "دفعة العهدة للجرد": "Custody lot for stocktake",
 "موقع العهدة للعبوة": "Custody location for package",
 "دفعة العبوة في العهدة": "Custody package lot",
 "شريحة الاستلام / العبوة": "Receipt / package tranche",
 "اختر شريحة الاستلام": "Select receipt tranche",
 "ملاحظة إغلاق العبوة / التخلص الآمن": "Package closure / safe disposal note",
 "تم تسجيل استهلاك العهدة وتخفيض رصيد العهدة ومخزون المركز.": "Custody consumption recorded; custody and clinic inventory balances decreased.",
 "تم إرجاع المادة الصالحة من العهدة إلى المخزن؛ الكمية والقيمة تبقيان ضمن مخزون المركز.": "Valid material returned from custody to store; quantity and value remain in clinic inventory.",
 "تم تسجيل نتيجة جرد العهدة للمراجعة دون تعديل تلقائي للرصيد.": "Custody stocktake recorded for review without automatic balance adjustment.",
 "تم توثيق إغلاق العبوة أو التخلص الآمن وفق السياسة المعتمدة.": "Package closure or safe disposal documented per approved policy.",
 "تم حفظ مقترح أو اعتراض المقارنة السنوية للمراجعة دون أثر مالي تلقائي.": "Annual comparison proposal or objection saved for review without automatic financial effect.",
 "تم تخصيص الحركات التاريخية دون مضاعفة رصيد المخزون.": "Historical movements allocated without duplicating inventory balance.",
 "اختر طبيب العهدة والفترة والمخصوم الفعلي وسبب المقارنة قبل الحفظ.": "Select custody doctor, period, applied deductions, and comparison reason before saving.",
 "اكتب سبب الاعتراض قبل التسجيل.": "Enter the objection reason before submitting.",
 "حدث خطأ غير متوقع في معالجة المخزون. يرجى المحاولة لاحقًا.": "An unexpected inventory processing error occurred. Please try again later.",
 "تعذّر تنفيذ العملية. راجع المدخلات والصلاحية.": "The operation could not be completed. Check inputs and permissions.",
 "لا تملك صلاحية تنفيذ هذه العملية.": "You do not have permission to perform this operation.",
 "تتطلب هذه العملية صلاحية الإدارة.": "This operation requires administrator permission.",
 "العهدة المحددة لا تخص هذا الطبيب أو غير مصرح بها.": "The selected custody does not belong to this doctor or is unauthorized.",
 "لا تملك صلاحية التصرف في عهدة طبيب آخر.": "You are not authorized to act on another doctor's custody.",
 "لا تملك صلاحية الاطلاع على كشوف عهد المواد للأطباء.": "You are not authorized to view doctor material custody statements.",
 "لا تملك صلاحية ربط الاستهلاك بهذا الملف السريري.": "You are not authorized to link consumption to this clinical record.",
 "بيانات المريض أو الزيارة أو الإجراء غير متطابقة أو غير موجودة.": "Patient, visit, or procedure data is mismatched or not found.",
 "يتطلب إثبات التالف في العهدة اعتمادًا إداريًا مستقلًا وصالحًا.": "Custody waste requires a valid independent administrative approval.",
 "الدفعة المحددة لم يسبق استلامها في موقع العهدة هذا.": "The selected lot has not been received in this custody location.",
 "كميات إغلاق العبوة لا تطابق السجل الفعلي لحركة الدفعة في العهدة.": "Package closure quantities do not match the actual custody lot movement history.",
 "معرّف العبوة غير مرتبط بتحويل أو تخصيص استلام فعلي.": "Package ID is not linked to an actual transfer or receipt allocation.",
 "معرّف العبوة لا يطابق موقع العهدة أو الدفعة المحددة.": "Package ID does not match the selected custody location or lot.",
 "معرّف العبوة يطابق أكثر من شريحة استلام مفتوحة؛ اختر شريحة الاستلام المحددة.": "Package ID matches multiple open receipt tranches; select the specific receipt tranche.",
 "تتطلب إغلاقات العبوات التاريخية على سطر التحويل هذا تحديد نسبتها لكل استلام أولًا.": "Legacy package closures on this transfer line require per-acknowledgement attribution first.",
 "معرّف واقعة الإثبات غير مرتبط بسجل استهلاك أو جرد أو تالف أو إرجاع فعلي.": "Evidence event ID is not linked to an actual consumption, stocktake, waste, or return record.",
 "معرّف واقعة الإثبات لا يطابق موقع العهدة أو الدفعة المحددة.": "Evidence event ID does not match the selected custody location or lot.",
 "معرّف واقعة الإثبات يطابق أكثر من سجل؛ حدد معرّف الواقعة بدقة.": "Evidence event ID matches multiple records; specify the exact event ID.",
 "لا يُسمح بتغيير سياسة إثبات العبوة الافتراضية دون تصعيد خطورة موثق.": "Changing the default package evidence policy is not permitted without documented hazard escalation.",
 "الأدوات الحادة والمواد الملوثة لا تعاد كعبوات فارغة؛ يلزم توثيق التخلص الآمن.": "Sharps and contaminated materials cannot be returned as empty packages; safe disposal must be documented.",
 "لا يمكن خصم تسوية غير مرحّلة ماليًا من المقارنة السنوية.": "Unposted financial adjustments cannot be deducted from the annual comparison.",
 "أرقام الاستهلاك المرسلة لا تطابق السجل الفعلي المؤكد في النظام.": "Submitted consumption figures do not match the confirmed system record.",
 "صيغة فترة المقارنة السنوية غير صالحة.": "Invalid annual comparison period format.",
 "يتعذر ربط الصرف التاريخي بدفعة سابقة مؤكدة دون تخمين بأثر رجعي.": "Cannot link historical issue to a confirmed prior lot without retroactive guessing.",
 "الرصيد التاريخي لا يكفي لتسوية حركات الصرف دون تخمين رصيد افتتاحي.": "Historical balance is insufficient to reconcile issue movements without guessing an opening balance.",
 "تمت تسوية الحركات التاريخية لهذا البند بالفعل.": "Historical movements for this item have already been reconciled.",
 "تم إغلاق هذه العبوة أو استخدام مستند الإثبات مسبقًا.": "This package has already been closed or the evidence record was already used.",
 "حركة الاستهلاك أو الإرجاع مسجلة مسبقًا لهذا المفتاح.": "Consumption or return movement is already recorded for this key.",
 "الكمية المؤكدة تتجاوز الكمية المرسلة في التحويل.": "Confirmed quantity exceeds the dispatched transfer quantity.",
 "تم إدراج تسوية مكررة في المقارنة السنوية.": "Duplicate settlement adjustment included in the annual comparison.",
 "السجل المطلوب غير موجود.": "The requested record was not found.",
 "رصيد الدفعة المتاح لا يكفي للكمية المطلوبة.": "Available lot balance is insufficient for the requested quantity.",
 "لا يمكن صرف دفعة منتهية الصلاحية أو محجورة.": "Cannot issue an expired or quarantined lot."
};
type Statement=Awaited<ReturnType<typeof readDoctorCustody>>;
export function DoctorCustody(){const session=useSession();return <CustodyStatement key={`${session?.username??"none"}:${session?.role??"none"}`} session={session}/>;}
function CustodyStatement({session}:{session:SessionInfo|null}){
 const [locale,setLocale]=useState<"ar"|"en">("ar");const text=(value:string)=>locale==="en"?(english[value]??value):value;
 const [revision,setRevision]=useState(0);const [offset,setOffset]=useState(0);const [loaded,setLoaded]=useState<{key:string;data:Statement}|null>(null);const [failed,setFailed]=useState<{key:string;message:string}|null>(null);
 const [source,setSource]=useState("");const [destination,setDestination]=useState("");const [transit,setTransit]=useState("");const [lotId,setLotId]=useState("");const [quantity,setQuantity]=useState("");const [reason,setReason]=useState("");const [validation,setValidation]=useState("");
 const [legacyItemId,setLegacyItemId]=useState("");const [legacyLocationId,setLegacyLocationId]=useState("");const [legacyReason,setLegacyReason]=useState("");
 const [usageLocationId,setUsageLocationId]=useState("");const [usageLotId,setUsageLotId]=useState("");const [usageKind,setUsageKind]=useState<"consumed"|"approved_waste"|"returned_to_store">("consumed");const [usageQty,setUsageQty]=useState("");const [usageQtyState,setUsageQtyState]=useState<"confirmed"|"estimated">("confirmed");const [usageStoreId,setUsageStoreId]=useState("");const [usagePatientId,setUsagePatientId]=useState("");const [usageVisitId,setUsageVisitId]=useState("");const [usageProcedureId,setUsageProcedureId]=useState("");const [usageWasteApproval,setUsageWasteApproval]=useState("");const [usageReason,setUsageReason]=useState("");
 const [stocktakeLocationId,setStocktakeLocationId]=useState("");const [stocktakeLotId,setStocktakeLotId]=useState("");const [stocktakeCounted,setStocktakeCounted]=useState("");const [stocktakeReason,setStocktakeReason]=useState("");
 const [pkgLocationId,setPkgLocationId]=useState("");const [pkgLotId,setPkgLotId]=useState("");const [pkgId,setPkgId]=useState("");const [pkgEventId,setPkgEventId]=useState("");const [pkgHazard,setPkgHazard]=useState<"none"|"sharp"|"contaminated">("none");const [pkgPolicy,setPkgPolicy]=useState<"safe_empty_return"|"safe_disposal_record"|"bulk_count"|"reusable_custody">("safe_empty_return");const [pkgOriginal,setPkgOriginal]=useState("");const [pkgConsumed,setPkgConsumed]=useState("");const [pkgReturned,setPkgReturned]=useState("0");const [pkgWaste,setPkgWaste]=useState("0");const [pkgRemaining,setPkgRemaining]=useState("0");const [pkgReason,setPkgReason]=useState("");
 const [settleDoctorPartyId,setSettleDoctorPartyId]=useState("");const [settlePeriodId,setSettlePeriodId]=useState("2026-annual");const [settleCurrency,setSettleCurrency]=useState<"YER"|"SAR"|"USD">("SAR");const [settleDeductions,setSettleDeductions]=useState("");const [settleAttributable,setSettleAttributable]=useState("");const [settleReason,setSettleReason]=useState("");
 const [objectionReasons,setObjectionReasons]=useState<Record<string,string>>({});
 const [wasteLocationId,setWasteLocationId]=useState("");const [wasteLotId,setWasteLotId]=useState("");const [wasteMax,setWasteMax]=useState("");const [wasteReason,setWasteReason]=useState("");const [lastWasteApproval,setLastWasteApproval]=useState("");
 const [ackReason,setAckReason]=useState<Record<string,string>>({});const [ackValues,setAckValues]=useState<Record<string,{accepted:string;returned:string}>>({});const [feedback,setFeedback]=useState("");const [pendingFeedback,setPendingFeedback]=useState("تم حفظ التحويل وإثباته. الكمية والقيمة تبقيان ضمن مخزون المركز.");const command=useInventoryCommand("custody");
 const key=`${session?.username??"none"}:${session?.role??"none"}:${revision}:${offset}`;const data=loaded?.key===key?loaded.data:null;const error=failed?.key===key?failed.message:null;
 useEffect(()=>{if(!session)return;let alive=true;const controller=new AbortController();fetch(`/api/inventory/procurement?view=custody&offset=${offset}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.message??"تعذّر تحميل العهد.");if(alive){setLoaded({key,data:value});setFailed(null);}}).catch(error=>{if(alive)setFailed({key,message:error instanceof Error?error.message:"تعذّر تحميل العهد."});});return()=>{alive=false;controller.abort();};},[key,session,offset]);
 const complete=(nextFeedback=pendingFeedback)=>{setQuantity("");setReason("");setLegacyItemId("");setLegacyLocationId("");setLegacyReason("");setUsageQty("");setUsageReason("");setStocktakeCounted("");setStocktakeReason("");setPkgLotId("");setPkgId("");setPkgEventId("");setPkgReason("");setSettleReason("");setValidation("");setFeedback(nextFeedback);setRevision(value=>value+1);};
 const sourceLots=data?.locations.find(place=>place.id===source)?.lots.filter(lot=>lot.availability==="available")??[];
 const custodyLocations=data?.locations.filter(place=>place.kind==="custody")??[];
 const usageLots=custodyLocations.find(place=>place.id===usageLocationId)?.lots??[];
 const stocktakeLots=custodyLocations.find(place=>place.id===stocktakeLocationId)?.lots??[];
 const wasteLots=custodyLocations.find(place=>place.id===wasteLocationId)?.lots??[];
 const selectedPkgLocation=custodyLocations.find(place=>place.id===pkgLocationId);
 const pkgLots=selectedPkgLocation?.closableLots??[];
 const selectedPkgLot=pkgLots.find(lot=>lot.lotId===pkgLotId);
 const selectedPkgTranches=selectedPkgLot&&"tranches" in selectedPkgLot&&Array.isArray(selectedPkgLot.tranches)?selectedPkgLot.tranches:[];
 const selectedPkgLockedHazard=selectedPkgLot&&(selectedPkgLot.defaultHazard==="sharp"||selectedPkgLot.defaultHazard==="contaminated")?selectedPkgLot.defaultHazard:null;
 const storeOptions=data&&"storeLocations" in data&&Array.isArray(data.storeLocations)?data.storeLocations:data?.locations.filter(row=>row.kind==="store").map(row=>({id:row.id,label:row.label}))??[];
 async function dispatch(event:React.FormEvent){event.preventDefault();setValidation("");if(!data||command.locked)return;if(!source||!destination||!transit||!lotId||!quantity.trim()||!reason.trim()){setValidation("اختر المصدر والعهدة وقيد النقل والدفعة، واكتب الكمية والسبب.");return;}
  const msg="تم حفظ التحويل وإثباته. الكمية والقيمة تبقيان ضمن مخزون المركز.";setPendingFeedback(msg);
  const document:CustodyDispatch={id:crypto.randomUUID(),fromLocationId:source,toLocationId:destination,transitLocationId:transit,reason:reason.trim(),lines:[{id:crypto.randomUUID(),lotId,quantity}]};if(await command.send("custody.dispatch",{transfer:document}))complete(msg);
 }
 async function reconcileLegacy(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!legacyItemId||!legacyLocationId||!legacyReason.trim()){setValidation("اختر المادة والمخزن واكتب سبب التسوية التاريخية.");return;}
  const msg="تم تخصيص الحركات التاريخية دون مضاعفة رصيد المخزون.";setPendingFeedback(msg);
  if(await command.send("legacy.reconcile",{reconciliation:{id:crypto.randomUUID(),itemId:Number(legacyItemId),locationId:legacyLocationId,reason:legacyReason.trim()}}))complete(msg);
 }
 async function submitUsage(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!usageLocationId||!usageLotId||!usageQty.trim()||!usageReason.trim()||(usageKind==="returned_to_store"&&!usageStoreId)||(usageKind==="approved_waste"&&!usageWasteApproval.trim())){setValidation("اختر موقع العهدة والدفعة والكمية والسبب قبل الحفظ.");return;}
  const cmd=usageKind==="returned_to_store"?"custody.return_to_store":"custody.consume";
  const msg=usageKind==="returned_to_store"?"تم إرجاع المادة الصالحة من العهدة إلى المخزن؛ الكمية والقيمة تبقيان ضمن مخزون المركز.":"تم تسجيل استهلاك العهدة وتخفيض رصيد العهدة ومخزون المركز.";setPendingFeedback(msg);
  if(await command.send(cmd,{usage:{id:crypto.randomUUID(),locationId:usageLocationId,storeLocationId:usageKind==="returned_to_store"?usageStoreId:null,lotId:usageLotId,kind:usageKind,quantity:usageQty.trim(),quantityState:usageQtyState,patientId:usageKind==="consumed"?usagePatientId.trim()||null:null,visitId:usageKind==="consumed"?usageVisitId.trim()||null:null,procedureId:usageKind==="consumed"?usageProcedureId.trim()||null:null,wasteApprovalId:usageKind==="approved_waste"?usageWasteApproval.trim():null,reason:usageReason.trim()}}))complete(msg);
 }
 async function submitWasteApproval(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!wasteLocationId||!wasteLotId||!wasteMax.trim()||!wasteReason.trim()){setValidation("اختر موقع العهدة والدفعة، واكتب الحد الأقصى للتالف وسبب الاعتماد.");return;}
  const id=crypto.randomUUID();const msg="تم اعتماد التالف بحد أقصى. انسخ رقم الاعتماد للطبيب لتسجيل التالف الفعلي.";setPendingFeedback(msg);
  if(await command.send("custody.approve_waste",{wasteApproval:{id,locationId:wasteLocationId,lotId:wasteLotId,maxQuantity:wasteMax.trim(),reason:wasteReason.trim()}})){setLastWasteApproval(id);setWasteMax("");setWasteReason("");complete(msg);}
 }
 async function submitStocktake(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!stocktakeLocationId||!stocktakeLotId||!stocktakeCounted.trim()||!stocktakeReason.trim()){setValidation("اختر موقع العهدة والدفعة والكمية والسبب قبل الحفظ.");return;}
  const msg="تم تسجيل نتيجة جرد العهدة للمراجعة دون تعديل تلقائي للرصيد.";setPendingFeedback(msg);
  if(await command.send("custody.stocktake",{stocktake:{id:crypto.randomUUID(),locationId:stocktakeLocationId,lotId:stocktakeLotId,countedQuantity:stocktakeCounted.trim(),reason:stocktakeReason.trim()}}))complete(msg);
 }
 async function submitPackageClosure(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!pkgLocationId||!pkgLotId||!pkgId.trim()||!pkgEventId.trim()||!pkgOriginal.trim()||!pkgConsumed.trim()||!pkgReason.trim()){setValidation("اختر موقع العهدة والدفعة والكمية والسبب قبل الحفظ.");return;}
  const msg="تم توثيق إغلاق العبوة أو التخلص الآمن وفق السياسة المعتمدة.";setPendingFeedback(msg);
  if(await command.send("custody.close_package",{packageClosure:{id:crypto.randomUUID(),packageId:pkgId.trim(),evidenceEventId:pkgEventId.trim(),locationId:pkgLocationId,lotId:pkgLotId,hazard:pkgHazard,policy:pkgPolicy,originalQuantity:pkgOriginal.trim(),recordedConsumptionQuantity:pkgConsumed.trim(),returnedOrTransferredQuantity:pkgReturned.trim()||"0",approvedWasteQuantity:pkgWaste.trim()||"0",remainingQuantity:pkgRemaining.trim()||"0",reason:pkgReason.trim()}}))complete(msg);
 }
 async function submitSettlementProposal(event:React.FormEvent){
  event.preventDefault();setValidation("");if(!data||command.locked)return;
  if(!settleDoctorPartyId||!settlePeriodId.trim()||!/^\d+$/.test(settleDeductions.trim())||(settleAttributable.trim()!==""&&!/^\d+$/.test(settleAttributable.trim()))||!settleReason.trim()){setValidation("اختر طبيب العهدة والفترة والمخصوم الفعلي وسبب المقارنة قبل الحفظ.");return;}
  const msg="تم حفظ مقترح أو اعتراض المقارنة السنوية للمراجعة دون أثر مالي تلقائي.";setPendingFeedback(msg);
  if(await command.send("custody.propose_settlement",{settlement:{id:crypto.randomUUID(),doctorPartyId:Number(settleDoctorPartyId),periodId:settlePeriodId.trim(),currency:settleCurrency,appliedDeductionsMinor:Number(settleDeductions.trim()),attributableConsumptionMinor:settleAttributable.trim()===""?null:Number(settleAttributable.trim()),prerequisitesComplete:false,reason:settleReason.trim()}}))complete(msg);
 }
 async function submitSettlementObjection(settlementId:string){
  setValidation("");if(command.locked)return;
  const objReason=objectionReasons[settlementId]?.trim()??"";
  if(!objReason){setValidation("اكتب سبب الاعتراض قبل التسجيل.");return;}
  const msg="تم حفظ مقترح أو اعتراض المقارنة السنوية للمراجعة دون أثر مالي تلقائي.";setPendingFeedback(msg);
  if(await command.send("custody.object_settlement",{objection:{id:crypto.randomUUID(),settlementId,reason:objReason}}))complete(msg);
 }
 async function acknowledge(transfer:Statement["pendingTransfers"][number]){setValidation("");if(command.locked)return;if(!ackReason[transfer.id]?.trim()){setValidation("اكتب نتيجة العد وسبب أي فرق قبل تأكيد الاستلام.");return;}const msg="تم حفظ التحويل وإثباته. الكمية والقيمة تبقيان ضمن مخزون المركز.";setPendingFeedback(msg);const lines=transfer.lines.map(line=>({lineId:line.id,acceptedQuantity:ackValues[line.id]?.accepted??line.remainingQuantity,returnedQuantity:ackValues[line.id]?.returned??"0"}));if(await command.send("custody.acknowledge",{acknowledgement:{id:crypto.randomUUID(),transferId:transfer.id,reason:ackReason[transfer.id],lines}}))complete(msg);}
 return <section dir={locale==="ar"?"rtl":"ltr"} lang={locale} className={`${styles.root} space-y-5`} data-testid="doctor-custody">
  <div className={styles.toolbar}><div><h1 className={styles.title}>{text("عهد المواد للأطباء")}</h1><p className={styles.caption}>{text("المخزن · قيد النقل · عهدة الطبيب")}</p></div><Link href="/inventory" className={styles.button}>{text("المخزون")}</Link></div>
  <div className={styles.actions}><button type="button" className={styles.button} onClick={()=>setLocale(locale==="ar"?"en":"ar")}>{locale==="ar"?"English":"العربية"}</button><button type="button" className={styles.button} disabled={!data||command.locked} onClick={()=>window.print()}>{locale==="ar"?"طباعة كشف العهدة":"Print custody statement"}</button><Link href="/inventory/procurement" className={styles.button}>{text("طلبات شراء المواد")}</Link><button type="button" className={styles.button} disabled={command.locked} onClick={()=>setRevision(value=>value+1)}><RefreshCw aria-hidden="true" size={16}/>{text("تحديث")}</button></div>
  {error?<p className={styles.feedback} role="alert">{text(error)}</p>:!data?<p className={styles.feedback} role="status">{text("جارٍ تحميل العهد…")}</p>:<>
   <div className={styles.printHeader}><ReportPrintHeader title={text("عهد المواد للأطباء")} subtitle={locale==="ar"?"الكميات المخصصة للمواقع · ليست تسوية مالية":"Allocated location quantities · Not a financial settlement"}/></div>
   <div className={`${styles.panel} ${styles.note}`}><ShieldCheck className="inline-block ms-2" size={18} aria-hidden="true"/>{text("مواد العهدة تبقى ملكًا للمركز. الاستهلاك يسجل مستقلًا بمصدره. فروق الجرد والتسوية تحتاج مراجعة واعتمادًا؛ لا ينشأ خصم راتب أو دين تلقائي.")}</div>
   {data.reconciliationRequired.length?<p className={styles.feedback} role="alert">{locale==="ar"?`توجد ${data.reconciliationRequired.length} مواد بحركات غير مخصصة للدفعات والمواقع. يتوقف تحويلها حتى مراجعة التتبع.`:`${data.reconciliationRequired.length} items have movements without lot/location allocations. Transfers stop until tracking is reconciled.`}</p>:null}
   {"legacySourceReconciliationRequired" in data&&Array.isArray(data.legacySourceReconciliationRequired)&&data.legacySourceReconciliationRequired.length?<p className={styles.feedback} role="alert" data-testid="legacy-source-reconciliation-alert">{text("تتطلب إغلاقات العبوات التاريخية على سطر التحويل هذا تحديد نسبتها لكل استلام أولًا.")}</p>:null}
   {inventoryCan(session,"inventory.reconcile")&&data.reconciliationRequired.length?<div className={`${styles.panel} ${styles.screenControls}`} data-testid="legacy-reconciliation-form"><h2 className={styles.panelHeading}><span>{text("تسوية الحركات التاريخية غير المخصصة")}</span></h2><form noValidate onSubmit={reconcileLegacy} className="space-y-4 p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{text("المادة التي تحتاج تسوية تتبع")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("المادة التي تحتاج تسوية تتبع")} disabled={command.locked} value={legacyItemId} onChange={event=>setLegacyItemId(event.target.value)}><option value="">{text("اختر المادة")}</option>{data.reconciliationRequired.map(row=><option key={row.itemId} value={row.itemId}>{("name" in row&&row.name)?row.name:`#${row.itemId}`} — {row.clinicQuantity} / {row.allocatedQuantity}</option>)}</select></label><label className="text-sm">{text("مخزن التخصيص الافتراضي")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("مخزن التخصيص الافتراضي")} disabled={command.locked} value={legacyLocationId} onChange={event=>setLegacyLocationId(event.target.value)}><option value="">{text("اختر المخزن")}</option>{storeOptions.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label></div><label className="block text-sm">{text("سبب التسوية التاريخية")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" rows={2} maxLength={2000} disabled={command.locked} value={legacyReason} onChange={event=>setLegacyReason(event.target.value)}/></label><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("تخصيص الحركات التاريخية دون مضاعفة الرصيد")}</button></form></div>:null}
   <div className={styles.items}>{data.locations.map(place=><article key={place.id} className={styles.item} data-location={place.id}><h2 className="font-bold text-base">{place.label}</h2><p className={styles.caption}>{place.kind==="custody"?text("عهدة طبيب"):place.kind==="transit"?text("قيد النقل"):text("مخزن المركز")}</p>{place.lots.length?<ul className="mt-3 space-y-4">{place.lots.map(lot=><li key={lot.lotId}><div className="flex justify-between gap-2"><b>{lot.name}</b><span className={styles.badge} data-state={lot.availability==="available"?"known":"missing"}>{lot.availability==="available"?text("صالح متاح"):text("غير متاح للصرف")}</span></div><p className="mt-1"><bdi>{lot.quantity} {lot.unit}</bdi></p>{lot.heldQuantity!=="0"?<p className={styles.caption}>{text("المتاح للصرف:")} <bdi>{lot.availableQuantity} {lot.unit}</bdi> · {text("قيد الحجر:")} <bdi>{lot.heldQuantity} {lot.unit}</bdi></p>:null}<p className={styles.caption}>LOT: <bdi>{lot.lotCode??text("غير معروف")}</bdi> · {locale==="ar"?"الصلاحية:":"Expiry:"} <bdi>{lot.expiryDate??text("لا تنطبق / غير مؤكدة")}</bdi></p>{"quote" in lot&&lot.quote?<p className={styles.caption}>{text("تقدير العرض الأصلي:")} {formatMoney(lot.quote.amountMinor,lot.quote.currency)} · {text("تكلفة تقديرية")}</p>:null}{"quote" in lot&&!lot.quote?<p className={styles.caption}>{locale==="ar"?"تكلفة العرض مجهولة":"Quote cost is unknown"}</p>:null}{lot.trackingState==="incomplete"?<p className="text-xs text-amber-900">{text("التتبع يحتاج مراجعة")}</p>:null}</li>)}</ul>:<p className={`${styles.caption} mt-3`}>{text("لا توجد كمية مخصصة لهذا الموقع.")}</p>}</article>)}</div>
   {inventoryCan(session,"inventory.custody.dispatch")?<div className={`${styles.panel} ${styles.screenControls}`} data-testid="custody-dispatch-form"><h2 className={styles.panelHeading}><span>{text("تسليم عهدة / تحويل مادة")}</span><ArrowLeftRight size={18} aria-hidden="true"/></h2><form noValidate onSubmit={dispatch} className="space-y-4 p-4"><div className="grid gap-3 sm:grid-cols-3">
    <label className="text-sm">{text("المصدر")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("المصدر")} disabled={command.locked} value={source} onChange={event=>{setSource(event.target.value);setLotId("");}}><option value="">{text("اختر الموقع")}</option>{data.locations.filter(row=>row.kind!=="transit").map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label className="text-sm">{text("العهدة / الوجهة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("العهدة / الوجهة")} disabled={command.locked} value={destination} onChange={event=>setDestination(event.target.value)}><option value="">{text("اختر الوجهة")}</option>{data.locations.filter(row=>row.kind!=="transit"&&row.id!==source).map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label className="text-sm">{text("موقع قيد النقل")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع قيد النقل")} disabled={command.locked} value={transit} onChange={event=>setTransit(event.target.value)}><option value="">{text("اختر موقع قيد النقل")}</option>{data.locations.filter(row=>row.kind==="transit").map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
   </div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{text("الدفعة الصالحة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("الدفعة الصالحة")} disabled={command.locked} value={lotId} onChange={event=>setLotId(event.target.value)}><option value="">{text("اختر دفعة")}</option>{sourceLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {lot.availableQuantity} {lot.unit} · {lot.lotCode??"LOT غير معروف"}</option>)}</select></label><label className="text-sm">{text("كمية التحويل")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} inputMode="decimal" value={quantity} onChange={event=>setQuantity(event.target.value)}/></label></div><label className="block text-sm">{text("سبب التسليم / التحويل")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" rows={2} maxLength={2000} disabled={command.locked} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("إرسال المادة إلى قيد النقل")}</button></form></div>:null}
   <div className={`${styles.panel} ${styles.screenControls}`}><h2 className={styles.panelHeading}><span>{text("تحويلات تنتظر إثبات الاستلام")}</span><ClipboardCheck size={18} aria-hidden="true"/></h2><div className="space-y-4 p-4">{data.pendingTransfers.map(transfer=><article key={transfer.id} className={styles.item}><h3 className="font-bold">{transfer.fromLabel} ← {transfer.destinationLabel}</h3><p className={styles.caption}>{transfer.reason}</p>{transfer.lines.map(line=><div key={line.id} className="mt-3 grid gap-2 sm:grid-cols-3"><p>{line.name} · {locale==="ar"?"المتبقي":"Remaining"} <bdi>{line.remainingQuantity} {line.unit}</bdi></p><label className="text-sm">{text("المقبول الآن")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={ackValues[line.id]?.accepted??line.remainingQuantity} onChange={event=>setAckValues(current=>({...current,[line.id]:{accepted:event.target.value,returned:current[line.id]?.returned??"0"}}))}/></label><label className="text-sm">{text("الراجع للمصدر")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={ackValues[line.id]?.returned??"0"} onChange={event=>setAckValues(current=>({...current,[line.id]:{accepted:current[line.id]?.accepted??line.remainingQuantity,returned:event.target.value}}))}/></label></div>)}<label className="block mt-3 text-sm">{text("نتيجة العد / سبب الفرق")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" disabled={command.locked} rows={2} maxLength={2000} value={ackReason[transfer.id]??""} onChange={event=>setAckReason(current=>({...current,[transfer.id]:event.target.value}))}/></label><button type="button" className={`${styles.button} ${styles.primary}`} disabled={command.locked} onClick={()=>void acknowledge(transfer)}>{text("تأكيد الكميات المستلمة")}</button></article>)}{!data.pendingTransfers.length?<p className={styles.caption}>{text("لا توجد تحويلات معلقة في هذا النطاق.")}</p>:null}<div className={styles.actions}><button type="button" className={styles.button} disabled={command.locked||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-20))}>{text("السابق")}</button><span className={styles.caption}>{text("صفحة")} <bdi>{Math.floor(offset/20)+1}</bdi></span><button type="button" className={styles.button} disabled={command.locked||!data.hasMoreTransfers} onClick={()=>setOffset(value=>value+20)}>{text("التالي")}</button></div></div></div>
   <div className={`${styles.panel} ${styles.screenControls}`} data-testid="custody-usage-form">
    <h2 className={styles.panelHeading}><span>{text("تسجيل استهلاك فعلي أو إرجاع للمخزن")}</span></h2>
    <form noValidate onSubmit={submitUsage} className="space-y-4 p-4">
     <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">{text("موقع العهدة للاستهلاك أو الإرجاع")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع العهدة للاستهلاك أو الإرجاع")} disabled={command.locked} value={usageLocationId} onChange={event=>{setUsageLocationId(event.target.value);setUsageLotId("");}}><option value="">{text("اختر الموقع")}</option>{custodyLocations.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label className="text-sm">{text("دفعة العهدة للاستهلاك أو الإرجاع")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("دفعة العهدة للاستهلاك أو الإرجاع")} disabled={command.locked} value={usageLotId} onChange={event=>setUsageLotId(event.target.value)}><option value="">{text("اختر دفعة")}</option>{usageLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {custodyUsageQuantity(lot,usageKind)} {lot.unit}{lot.heldQuantity!=="0"?` · ${text("قيد الحجر:")} ${lot.heldQuantity}`:""}</option>)}</select></label>
      <label className="text-sm">{text("نوع حركة العهدة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("نوع حركة العهدة")} disabled={command.locked} value={usageKind} onChange={event=>setUsageKind(event.target.value as "consumed"|"approved_waste"|"returned_to_store")}><option value="consumed">{text("استهلاك فعلي للمريض / الإجراء")}</option><option value="returned_to_store">{text("إرجاع مادة صالحة غير مستخدمة للمخزن")}</option><option value="approved_waste">{text("تالف معتمد من العهدة")}</option></select></label>
     </div>
     <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">{text("كمية الاستهلاك أو الإرجاع")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={usageQty} onChange={event=>setUsageQty(event.target.value)}/></label>
      <label className="text-sm">{text("حالة الكمية")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("حالة الكمية")} disabled={command.locked} value={usageQtyState} onChange={event=>setUsageQtyState(event.target.value as "confirmed"|"estimated")}><option value="confirmed">{text("مؤكدة فعليًا")}</option><option value="estimated">{text("تقديرية")}</option></select></label>
      {usageKind==="returned_to_store"?<label className="text-sm">{text("مخزن الإرجاع")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("مخزن الإرجاع")} disabled={command.locked} value={usageStoreId} onChange={event=>setUsageStoreId(event.target.value)}><option value="">{text("اختر المخزن")}</option>{storeOptions.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>:usageKind==="approved_waste"?<label className="text-sm">{text("مرجع اعتماد التالف")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={usageWasteApproval} onChange={event=>setUsageWasteApproval(event.target.value)}/></label>:<label className="text-sm">{text("معرف المريض (اختياري)")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={usagePatientId} onChange={event=>setUsagePatientId(event.target.value)}/></label>}
     </div>
     {usageKind==="consumed"?<div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{text("معرف الزيارة (اختياري)")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={usageVisitId} onChange={event=>setUsageVisitId(event.target.value)}/></label><label className="text-sm">{text("معرف الإجراء (اختياري)")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={usageProcedureId} onChange={event=>setUsageProcedureId(event.target.value)}/></label></div>:null}
     <label className="block text-sm">{text("سبب الاستهلاك أو الإرجاع")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" rows={2} maxLength={2000} disabled={command.locked} value={usageReason} onChange={event=>setUsageReason(event.target.value)}/></label>
     <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("حفظ حركة العهدة")}</button>
    </form>
   </div>
   {inventoryCan(session,"inventory.custody.approve-waste")?<div className={`${styles.panel} ${styles.screenControls}`} data-testid="custody-waste-approval-form">
    <h2 className={styles.panelHeading}><span>{text("اعتماد التالف (مستقل عن طبيب العهدة)")}</span></h2>
    <form noValidate onSubmit={submitWasteApproval} className="grid gap-3 p-4 md:grid-cols-2">
     <label className="block text-sm">{text("موقع العهدة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع العهدة للتالف")} disabled={command.locked} value={wasteLocationId} onChange={event=>{setWasteLocationId(event.target.value);setWasteLotId("");}}><option value="">{text("اختر الموقع")}</option>{custodyLocations.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
     <label className="block text-sm">{text("الدفعة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("دفعة التالف")} disabled={command.locked} value={wasteLotId} onChange={event=>setWasteLotId(event.target.value)}><option value="">{text("اختر دفعة")}</option>{wasteLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {lot.quantity} {lot.unit}</option>)}</select></label>
     <label className="block text-sm">{text("الحد الأقصى للكمية التالفة")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" aria-label={text("الحد الأقصى للكمية التالفة")} disabled={command.locked} value={wasteMax} onChange={event=>setWasteMax(event.target.value)}/></label>
     <label className="block text-sm">{text("سبب الاعتماد")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-2" rows={2} maxLength={2000} aria-label={text("سبب اعتماد التالف")} disabled={command.locked} value={wasteReason} onChange={event=>setWasteReason(event.target.value)}/></label>
     <div className="md:col-span-2 space-y-2"><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("اعتماد التالف")}</button>{lastWasteApproval?<p className="text-sm" data-testid="custody-waste-approval-id">{text("رقم الاعتماد:")} <bdi dir="ltr" className="font-mono select-all">{lastWasteApproval}</bdi></p>:null}<p className={styles.caption}>{text("الاعتماد حدٌّ أقصى فقط؛ لا يخصم شيئًا حتى يسجّل الطبيب التالف الفعلي برقم الاعتماد. لا أثر مالي تلقائي.")}</p></div>
    </form>
   </div>:null}
   <div className={`${styles.panel} ${styles.screenControls}`} data-testid="custody-stocktake-package-panel">
    <h2 className={styles.panelHeading}><span>{text("جرد العهدة وإثبات العبوات الفارغة / التخلص الآمن")}</span></h2>
    <div className="grid gap-6 p-4 md:grid-cols-2">
     <form noValidate onSubmit={submitStocktake} className="space-y-3" data-testid="custody-stocktake-form">
      <label className="block text-sm">{text("موقع العهدة للجرد")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع العهدة للجرد")} disabled={command.locked} value={stocktakeLocationId} onChange={event=>{setStocktakeLocationId(event.target.value);setStocktakeLotId("");}}><option value="">{text("اختر الموقع")}</option>{custodyLocations.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label className="block text-sm">{text("دفعة العهدة للجرد")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("دفعة العهدة للجرد")} disabled={command.locked} value={stocktakeLotId} onChange={event=>setStocktakeLotId(event.target.value)}><option value="">{text("اختر دفعة")}</option>{stocktakeLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {lot.quantity} {lot.unit}</option>)}</select></label>
      <label className="block text-sm">{text("الكمية الفعلية المعدودة")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={stocktakeCounted} onChange={event=>setStocktakeCounted(event.target.value)}/></label>
      <label className="block text-sm">{text("سبب الجرد / ملاحظة المطابقة")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-2" rows={2} maxLength={2000} disabled={command.locked} value={stocktakeReason} onChange={event=>setStocktakeReason(event.target.value)}/></label>
      <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("تسجيل نتيجة الجرد للمراجعة")}</button>
     </form>
     <form noValidate onSubmit={submitPackageClosure} className="space-y-3" data-testid="custody-package-closure-form">
      <div className="grid gap-2 sm:grid-cols-2">
       <label className="text-sm">{text("موقع العهدة للعبوة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع العهدة للعبوة")} disabled={command.locked} value={pkgLocationId} onChange={event=>{setPkgLocationId(event.target.value);setPkgLotId("");setPkgId("");setPkgEventId("");}}><option value="">{text("اختر الموقع")}</option>{custodyLocations.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
       <label className="text-sm">{text("دفعة العبوة في العهدة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("دفعة العبوة في العهدة")} disabled={command.locked} value={pkgLotId} onChange={event=>{const nextLotId=event.target.value;setPkgLotId(nextLotId);const chosen=pkgLots.find(lot=>lot.lotId===nextLotId);if(chosen&&"inboundQuantity" in chosen){const t0="tranches" in chosen&&Array.isArray(chosen.tranches)&&chosen.tranches.length>0?chosen.tranches[0]:null;setPkgOriginal(t0?t0.originalQuantity:chosen.inboundQuantity);setPkgConsumed(t0?t0.recordedConsumptionQuantity:chosen.consumedQuantity);setPkgReturned(t0?t0.returnedOrTransferredQuantity:chosen.returnedOrTransferredQuantity);setPkgWaste(t0?t0.approvedWasteQuantity:chosen.approvedWasteQuantity);setPkgRemaining(t0?t0.remainingQuantity:chosen.quantity);setPkgHazard(chosen.defaultHazard);setPkgPolicy(chosen.defaultPolicy);setPkgId(t0?.packageId??("defaultPackageId" in chosen&&chosen.defaultPackageId?chosen.defaultPackageId:""));setPkgEventId(t0?.defaultEvidenceEventId??("defaultEvidenceEventId" in chosen&&chosen.defaultEvidenceEventId?chosen.defaultEvidenceEventId:""));}else{setPkgId("");setPkgEventId("");}}}><option value="">{text("اختر دفعة")}</option>{pkgLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {lot.quantity} {lot.unit}</option>)}</select></label>
      </div>
      <label className="block text-sm">{text("شريحة الاستلام / العبوة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("شريحة الاستلام / العبوة")} disabled={command.locked||selectedPkgTranches.length===0} value={selectedPkgTranches.some(tr=>tr.packageId===pkgId)?pkgId:""} onChange={event=>{const nextPkgId=event.target.value;const tr=selectedPkgTranches.find(row=>row.packageId===nextPkgId);if(tr){setPkgId(tr.packageId);setPkgOriginal(tr.originalQuantity);setPkgConsumed(tr.recordedConsumptionQuantity);setPkgReturned(tr.returnedOrTransferredQuantity);setPkgWaste(tr.approvedWasteQuantity);setPkgRemaining(tr.remainingQuantity);if(tr.defaultEvidenceEventId)setPkgEventId(tr.defaultEvidenceEventId);}}}><option value="">{text("اختر شريحة الاستلام")}</option>{selectedPkgTranches.map(tr=><option key={tr.packageId} value={tr.packageId}>{tr.packageId} — {tr.originalQuantity} {selectedPkgLot?.unit??""}</option>)}</select></label>
      <div className="grid gap-2 sm:grid-cols-2">
       <label className="text-sm">{text("معرف العبوة الفريد")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={pkgId} onChange={event=>setPkgId(event.target.value)}/></label>
       <label className="text-sm">{text("معرف واقعة الإثبات")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={pkgEventId} onChange={event=>setPkgEventId(event.target.value)}/></label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
       <label className="text-sm">{text("تصنيف الخطورة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("تصنيف الخطورة")} disabled={command.locked} value={pkgHazard} onChange={event=>setPkgHazard(event.target.value as "none"|"sharp"|"contaminated")}><option value="none" disabled={selectedPkgLockedHazard!==null}>{text("آمنة غير ملوثة")}</option><option value="sharp">{text("أداة حادة")}</option><option value="contaminated">{text("ملوثة طبيًا")}</option></select></label>
       <label className="text-sm">{text("سياسة إثبات العبوة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("سياسة إثبات العبوة")} disabled={command.locked} value={pkgPolicy} onChange={event=>setPkgPolicy(event.target.value as "safe_empty_return"|"safe_disposal_record"|"bulk_count"|"reusable_custody")}><option value="safe_empty_return" disabled={selectedPkgLockedHazard!==null}>{text("إرجاع عبوة فارغة آمنة")}</option><option value="safe_disposal_record">{text("توثيق تخلص آمن")}</option><option value="bulk_count">{text("عدّ وقياس سائب")}</option><option value="reusable_custody">{text("عهدة قابلة لإعادة الاستخدام")}</option></select></label>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
       <label className="text-xs">{text("كمية العبوة الأصلية")}<input className="block mt-1 w-full rounded border border-blue-100 p-1.5" inputMode="decimal" disabled={command.locked} value={pkgOriginal} onChange={event=>setPkgOriginal(event.target.value)}/></label>
       <label className="text-xs">{text("المستهلك المسجل")}<input className="block mt-1 w-full rounded border border-blue-100 p-1.5" inputMode="decimal" disabled={command.locked} value={pkgConsumed} onChange={event=>setPkgConsumed(event.target.value)}/></label>
       <label className="text-xs">{text("المرتجع / المحول")}<input className="block mt-1 w-full rounded border border-blue-100 p-1.5" inputMode="decimal" disabled={command.locked} value={pkgReturned} onChange={event=>setPkgReturned(event.target.value)}/></label>
       <label className="text-xs">{text("التالف المعتمد")}<input className="block mt-1 w-full rounded border border-blue-100 p-1.5" inputMode="decimal" disabled={command.locked} value={pkgWaste} onChange={event=>setPkgWaste(event.target.value)}/></label>
       <label className="text-xs">{text("المتبقي بالعبوة")}<input className="block mt-1 w-full rounded border border-blue-100 p-1.5" inputMode="decimal" disabled={command.locked} value={pkgRemaining} onChange={event=>setPkgRemaining(event.target.value)}/></label>
      </div>
      <label className="block text-sm">{text("ملاحظة إغلاق العبوة / التخلص الآمن")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-2" rows={2} maxLength={2000} disabled={command.locked} value={pkgReason} onChange={event=>setPkgReason(event.target.value)}/></label>
      <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("توثيق إغلاق العبوة / التخلص الآمن")}</button>
     </form>
    </div>
   </div>
   <div className={`${styles.panel} ${styles.screenControls}`} data-testid="custody-annual-settlement-panel">
    <h2 className={styles.panelHeading}><span>{text("المقارنة السنوية بين استهلاك العهدة ومخصص إهلاك المواد")}</span></h2>
    <div className="space-y-4 p-4">
     <p className={styles.note}>{text("المقارنة السنوية للمراجعة والاعتماد فقط؛ لا تنشئ مديونية أو خصم راتب أو سندًا ماليًا تلقائيًا.")}</p>
     {inventoryCan(session,"inventory.custody.settlement.propose")?<form noValidate onSubmit={submitSettlementProposal} className="space-y-3" data-testid="custody-settlement-proposal-form">
      <div className="grid gap-3 sm:grid-cols-3">
       <label className="text-sm">{text("طبيب العهدة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("طبيب العهدة")} disabled={command.locked} value={settleDoctorPartyId} onChange={event=>setSettleDoctorPartyId(event.target.value)}><option value="">{text("اختر الموقع")}</option>{custodyLocations.filter(row=>row.doctorPartyId!==null).map(row=><option key={row.id} value={String(row.doctorPartyId)}>{row.label}</option>)}</select></label>
       <label className="text-sm">{text("الفترة / السنة")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} value={settlePeriodId} onChange={event=>setSettlePeriodId(event.target.value)}/></label>
       <label className="text-sm">{text("العملة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("العملة")} disabled={command.locked} value={settleCurrency} onChange={event=>setSettleCurrency(event.target.value as "YER"|"SAR"|"USD")}><option value="SAR">SAR</option><option value="YER">YER</option><option value="USD">USD</option></select></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
       <label className="text-sm">{text("المخصوم الفعلي للمواد (بالوحدات الصغرى)")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="numeric" disabled={command.locked} value={settleDeductions} onChange={event=>setSettleDeductions(event.target.value)}/></label>
       <label className="text-sm">{text("تكلفة الاستهلاك المنسوب للعهدة (بالوحدات الصغرى)")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="numeric" disabled={command.locked} value={settleAttributable} onChange={event=>setSettleAttributable(event.target.value)}/></label>
      </div>
      <label className="block text-sm">{text("سبب وملاحظات المقارنة السنوية")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-2" rows={2} maxLength={2000} disabled={command.locked} value={settleReason} onChange={event=>setSettleReason(event.target.value)}/></label>
      <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("إصدار مقترح المقارنة السنوية للمراجعة")}</button>
     </form>:null}
     {"settlements" in data&&Array.isArray(data.settlements)&&data.settlements.length?<div className="space-y-3">{data.settlements.map(row=><article key={row.id} className={styles.item}>
      <div className="flex flex-wrap justify-between gap-2"><b>{row.periodId} ({row.currency})</b><span className={styles.badge} data-state={row.status==="ready_for_authorized_review"?"known":"estimated"}>{row.status==="objected_under_review"?text("معترض عليه قيد المراجعة"):row.status==="ready_for_authorized_review"?text("جاهز للمراجعة المعتمدة"):text("مؤقت بانتظار الاستكمال")}</span></div>
      <p className={styles.caption}>D: <bdi>{formatMoney(row.appliedDeductionsMinor,row.currency)}</bdi> · A: <bdi>{row.attributableConsumptionMinor===null?text("غير معروف"):formatMoney(row.attributableConsumptionMinor,row.currency)}</bdi> · Δ: <bdi>{row.supplementalMinor===null?text("غير معروف"):formatMoney(Math.abs(row.supplementalMinor),row.currency)}</bdi> ({row.direction==="due_to_doctor"?text("لصالح الطبيب (مقترح)"):row.direction==="proposed_from_doctor"?text("على الطبيب (مقترح للمراجعة)"):row.direction==="balanced"?text("متوازن"):text("غير محسوم (بانتظار استكمال التتبع)")})</p>
      <p className={styles.caption}>{row.reason}</p>
      <div className="mt-2 flex flex-wrap gap-2"><input className="flex-1 rounded border border-blue-100 p-2 text-sm" placeholder={text("سبب الاعتراض")} disabled={command.locked} value={objectionReasons[row.id]??""} onChange={event=>setObjectionReasons(cur=>({...cur,[row.id]:event.target.value}))}/><button type="button" className={styles.button} disabled={command.locked} onClick={()=>void submitSettlementObjection(row.id)}>{text("تسجيل اعتراض الطبيب للمراجعة")}</button></div>
     </article>)}</div>:null}
    </div>
   </div>
   <p className={styles.note}>{text("تسليم العبوات الفارغة يخص العبوات الآمنة فقط. الأدوات الحادة والمواد الملوثة توثق إجراءات التخلص الآمن منها؛ لا تعاد للمخزن ولا تستخرج من النفايات للعد أو التصوير.")}</p>
  </>}
  {validation?<p role="alert" className="text-sm text-red-800">{text(validation)}</p>:null}{command.describe(locale)?<p className="text-sm" data-testid="inventory-saved-command">{command.describe(locale)}</p>:null}{command.message?<p role="alert" className="text-sm text-red-800">{text(command.message)}</p>:null}{command.status==="uncertain"?<button type="button" className={styles.button} onClick={async()=>{if(await command.retry())complete("تم تأكيد العملية المحفوظة. راجع سجل العهدة لمعرفة أثرها.");}}>{text("إعادة تأكيد العملية نفسها")}</button>:null}{feedback?<p role="status" className="text-sm text-green-800">{text(feedback)}</p>:null}
 </section>;
}

