"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
import { ArrowLeftRight,ClipboardCheck,RefreshCw,ShieldCheck } from "lucide-react";
import { useSession,type SessionInfo } from "@/components/SessionProvider";
import { ReportPrintHeader } from "@/components/ReportPrintHeader";
import { formatMoney } from "@/lib/money";
import type { readDoctorCustody,CustodyDispatch } from "@/lib/inventory-domain/custody-store";
import { useInventoryCommand } from "./useInventoryCommand";
import styles from "./inventory.module.css";
const english:Record<string,string>={
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
 "لم تُقبل العملية. راجع المدخلات والصلاحية.": "The operation was refused. Check inputs and permission."
};
type Statement=Awaited<ReturnType<typeof readDoctorCustody>>;
export function DoctorCustody(){const session=useSession();return <CustodyStatement key={`${session?.username??"none"}:${session?.role??"none"}`} session={session}/>;}
function CustodyStatement({session}:{session:SessionInfo|null}){
 const [locale,setLocale]=useState<"ar"|"en">("ar");const text=(value:string)=>locale==="en"?(english[value]??value):value;
 const [revision,setRevision]=useState(0);const [offset,setOffset]=useState(0);const [loaded,setLoaded]=useState<{key:string;data:Statement}|null>(null);const [failed,setFailed]=useState<{key:string;message:string}|null>(null);
 const [source,setSource]=useState("");const [destination,setDestination]=useState("");const [transit,setTransit]=useState("");const [lotId,setLotId]=useState("");const [quantity,setQuantity]=useState("");const [reason,setReason]=useState("");const [validation,setValidation]=useState("");
 const [ackReason,setAckReason]=useState<Record<string,string>>({});const [ackValues,setAckValues]=useState<Record<string,{accepted:string;returned:string}>>({});const [feedback,setFeedback]=useState("");const command=useInventoryCommand();
 const key=`${session?.username??"none"}:${session?.role??"none"}:${revision}:${offset}`;const data=loaded?.key===key?loaded.data:null;const error=failed?.key===key?failed.message:null;
 useEffect(()=>{if(!session)return;let alive=true;const controller=new AbortController();fetch(`/api/inventory/procurement?view=custody&offset=${offset}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.message??"تعذّر تحميل العهد.");if(alive){setLoaded({key,data:value});setFailed(null);}}).catch(error=>{if(alive)setFailed({key,message:error instanceof Error?error.message:"تعذّر تحميل العهد."});});return()=>{alive=false;controller.abort();};},[key,session,offset]);
 const complete=()=>{setQuantity("");setReason("");setValidation("");setFeedback("تم حفظ التحويل وإثباته. الكمية والقيمة تبقيان ضمن مخزون المركز.");setRevision(value=>value+1);};
 const sourceLots=data?.locations.find(place=>place.id===source)?.lots.filter(lot=>lot.availability==="available")??[];
 async function dispatch(event:React.FormEvent){event.preventDefault();setValidation("");if(!data||command.locked)return;if(!source||!destination||!transit||!lotId||!quantity.trim()||!reason.trim()){setValidation("اختر المصدر والعهدة وقيد النقل والدفعة، واكتب الكمية والسبب.");return;}
  const document:CustodyDispatch={id:crypto.randomUUID(),fromLocationId:source,toLocationId:destination,transitLocationId:transit,reason:reason.trim(),lines:[{id:crypto.randomUUID(),lotId,quantity}]};if(await command.send("custody.dispatch",{transfer:document}))complete();
 }
 async function acknowledge(transfer:Statement["pendingTransfers"][number]){setValidation("");if(command.locked)return;if(!ackReason[transfer.id]?.trim()){setValidation("اكتب نتيجة العد وسبب أي فرق قبل تأكيد الاستلام.");return;}const lines=transfer.lines.map(line=>({lineId:line.id,acceptedQuantity:ackValues[line.id]?.accepted??line.remainingQuantity,returnedQuantity:ackValues[line.id]?.returned??"0"}));if(await command.send("custody.acknowledge",{acknowledgement:{id:crypto.randomUUID(),transferId:transfer.id,reason:ackReason[transfer.id],lines}}))complete();}
 return <section dir={locale==="ar"?"rtl":"ltr"} lang={locale} className={`${styles.root} space-y-5`} data-testid="doctor-custody">
  <div className={styles.toolbar}><div><h1 className={styles.title}>{text("عهد المواد للأطباء")}</h1><p className={styles.caption}>{text("المخزن · قيد النقل · عهدة الطبيب")}</p></div><Link href="/inventory" className={styles.button}>{text("المخزون")}</Link></div>
  <div className={styles.actions}><button type="button" className={styles.button} onClick={()=>setLocale(locale==="ar"?"en":"ar")}>{locale==="ar"?"English":"العربية"}</button><button type="button" className={styles.button} disabled={!data||command.locked} onClick={()=>window.print()}>{locale==="ar"?"طباعة كشف العهدة":"Print custody statement"}</button><Link href="/inventory/procurement" className={styles.button}>{text("طلبات شراء المواد")}</Link><button type="button" className={styles.button} disabled={command.locked} onClick={()=>setRevision(value=>value+1)}><RefreshCw aria-hidden="true" size={16}/>{text("تحديث")}</button></div>
  {error?<p className={styles.feedback} role="alert">{text(error)}</p>:!data?<p className={styles.feedback} role="status">{text("جارٍ تحميل العهد…")}</p>:<>
   <div className={styles.printHeader}><ReportPrintHeader title={text("عهد المواد للأطباء")} subtitle={locale==="ar"?"الكميات المخصصة للمواقع · ليست تسوية مالية":"Allocated location quantities · Not a financial settlement"}/></div>
   <div className={`${styles.panel} ${styles.note}`}><ShieldCheck className="inline-block ms-2" size={18} aria-hidden="true"/>{text("مواد العهدة تبقى ملكًا للمركز. الاستهلاك يسجل مستقلًا بمصدره. فروق الجرد والتسوية تحتاج مراجعة واعتمادًا؛ لا ينشأ خصم راتب أو دين تلقائي.")}</div>
   {data.reconciliationRequired.length?<p className={styles.feedback} role="alert">{locale==="ar"?`توجد ${data.reconciliationRequired.length} مواد بحركات غير مخصصة للدفعات والمواقع. يتوقف تحويلها حتى مراجعة التتبع.`:`${data.reconciliationRequired.length} items have movements without lot/location allocations. Transfers stop until tracking is reconciled.`}</p>:null}
   <div className={styles.items}>{data.locations.map(place=><article key={place.id} className={styles.item} data-location={place.id}><h2 className="font-bold text-base">{place.label}</h2><p className={styles.caption}>{place.kind==="custody"?text("عهدة طبيب"):place.kind==="transit"?text("قيد النقل"):text("مخزن المركز")}</p>{place.lots.length?<ul className="mt-3 space-y-4">{place.lots.map(lot=><li key={lot.lotId}><div className="flex justify-between gap-2"><b>{lot.name}</b><span className={styles.badge} data-state={lot.availability==="available"?"known":"missing"}>{lot.availability==="available"?text("صالح متاح"):text("غير متاح للصرف")}</span></div><p className="mt-1"><bdi>{lot.quantity} {lot.unit}</bdi></p><p className={styles.caption}>LOT: <bdi>{lot.lotCode??text("غير معروف")}</bdi> · {locale==="ar"?"الصلاحية:":"Expiry:"} <bdi>{lot.expiryDate??text("لا تنطبق / غير مؤكدة")}</bdi></p>{"quote" in lot&&lot.quote?<p className={styles.caption}>{text("تقدير العرض الأصلي:")} {formatMoney(lot.quote.amountMinor,lot.quote.currency)} · {text("تكلفة تقديرية")}</p>:null}{"quote" in lot&&!lot.quote?<p className={styles.caption}>{locale==="ar"?"تكلفة العرض مجهولة":"Quote cost is unknown"}</p>:null}{lot.trackingState==="incomplete"?<p className="text-xs text-amber-900">{text("التتبع يحتاج مراجعة")}</p>:null}</li>)}</ul>:<p className={`${styles.caption} mt-3`}>{text("لا توجد كمية مخصصة لهذا الموقع.")}</p>}</article>)}</div>
   {session?.role==="admin"?<div className={`${styles.panel} ${styles.screenControls}`}><h2 className={styles.panelHeading}><span>{text("تسليم عهدة / تحويل مادة")}</span><ArrowLeftRight size={18} aria-hidden="true"/></h2><form noValidate onSubmit={dispatch} className="space-y-4 p-4"><div className="grid gap-3 sm:grid-cols-3">
    <label className="text-sm">{text("المصدر")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("المصدر")} disabled={command.locked} value={source} onChange={event=>{setSource(event.target.value);setLotId("");}}><option value="">{text("اختر الموقع")}</option>{data.locations.filter(row=>row.kind!=="transit").map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label className="text-sm">{text("العهدة / الوجهة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("العهدة / الوجهة")} disabled={command.locked} value={destination} onChange={event=>setDestination(event.target.value)}><option value="">{text("اختر الوجهة")}</option>{data.locations.filter(row=>row.kind!=="transit"&&row.id!==source).map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label className="text-sm">{text("موقع قيد النقل")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("موقع قيد النقل")} disabled={command.locked} value={transit} onChange={event=>setTransit(event.target.value)}><option value="">{text("اختر موقع قيد النقل")}</option>{data.locations.filter(row=>row.kind==="transit").map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
   </div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{text("الدفعة الصالحة")}<select className="block mt-1 w-full rounded border border-blue-100 p-2" aria-label={text("الدفعة الصالحة")} disabled={command.locked} value={lotId} onChange={event=>setLotId(event.target.value)}><option value="">{text("اختر دفعة")}</option>{sourceLots.map(lot=><option key={lot.lotId} value={lot.lotId}>{lot.name} — {lot.quantity} {lot.unit} · {lot.lotCode??"LOT غير معروف"}</option>)}</select></label><label className="text-sm">{text("كمية التحويل")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" disabled={command.locked} inputMode="decimal" value={quantity} onChange={event=>setQuantity(event.target.value)}/></label></div><label className="block text-sm">{text("سبب التسليم / التحويل")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" rows={2} maxLength={2000} disabled={command.locked} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={command.locked}>{text("إرسال المادة إلى قيد النقل")}</button></form></div>:null}
   <div className={`${styles.panel} ${styles.screenControls}`}><h2 className={styles.panelHeading}><span>{text("تحويلات تنتظر إثبات الاستلام")}</span><ClipboardCheck size={18} aria-hidden="true"/></h2><div className="space-y-4 p-4">{data.pendingTransfers.map(transfer=><article key={transfer.id} className={styles.item}><h3 className="font-bold">{transfer.fromLabel} ← {transfer.destinationLabel}</h3><p className={styles.caption}>{transfer.reason}</p>{transfer.lines.map(line=><div key={line.id} className="mt-3 grid gap-2 sm:grid-cols-3"><p>{line.name} · {locale==="ar"?"المتبقي":"Remaining"} <bdi>{line.remainingQuantity} {line.unit}</bdi></p><label className="text-sm">{text("المقبول الآن")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={ackValues[line.id]?.accepted??line.remainingQuantity} onChange={event=>setAckValues(current=>({...current,[line.id]:{accepted:event.target.value,returned:current[line.id]?.returned??"0"}}))}/></label><label className="text-sm">{text("الراجع للمصدر")}<input className="block mt-1 w-full rounded border border-blue-100 p-2" inputMode="decimal" disabled={command.locked} value={ackValues[line.id]?.returned??"0"} onChange={event=>setAckValues(current=>({...current,[line.id]:{accepted:current[line.id]?.accepted??line.remainingQuantity,returned:event.target.value}}))}/></label></div>)}<label className="block mt-3 text-sm">{text("نتيجة العد / سبب الفرق")}<textarea className="mt-1 w-full resize-none rounded border border-blue-100 p-3" disabled={command.locked} rows={2} maxLength={2000} value={ackReason[transfer.id]??""} onChange={event=>setAckReason(current=>({...current,[transfer.id]:event.target.value}))}/></label><button type="button" className={`${styles.button} ${styles.primary}`} disabled={command.locked} onClick={()=>void acknowledge(transfer)}>{text("تأكيد الكميات المستلمة")}</button></article>)}{!data.pendingTransfers.length?<p className={styles.caption}>{text("لا توجد تحويلات معلقة في هذا النطاق.")}</p>:null}<div className={styles.actions}><button type="button" className={styles.button} disabled={command.locked||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-20))}>{text("السابق")}</button><span className={styles.caption}>{text("صفحة")} <bdi>{Math.floor(offset/20)+1}</bdi></span><button type="button" className={styles.button} disabled={command.locked||!data.hasMoreTransfers} onClick={()=>setOffset(value=>value+20)}>{text("التالي")}</button></div></div></div>
   <p className={styles.note}>{text("تسليم العبوات الفارغة يخص العبوات الآمنة فقط. الأدوات الحادة والمواد الملوثة توثق إجراءات التخلص الآمن منها؛ لا تعاد للمخزن ولا تستخرج من النفايات للعد أو التصوير.")}</p>
  </>}
  {validation?<p role="alert" className="text-sm text-red-800">{text(validation)}</p>:null}{command.message?<p role="alert" className="text-sm text-red-800">{text(command.message)}</p>:null}{command.status==="uncertain"?<button type="button" className={styles.button} onClick={async()=>{if(await command.retry())complete();}}>{text("إعادة تأكيد العملية نفسها")}</button>:null}{feedback?<p role="status" className="text-sm text-green-800">{text(feedback)}</p>:null}
 </section>;
}
