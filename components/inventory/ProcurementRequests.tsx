"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PackagePlus, Plus, Send, X, RefreshCw, ClipboardCheck, Languages } from "lucide-react";
import { useSession, type SessionInfo } from "@/components/SessionProvider";
import { convertQuantity, type UnitConversionSnapshot } from "@/lib/inventory-domain/quantities";
import type { RequestRevision } from "@/lib/inventory-domain/procurement";
import styles from "./inventory.module.css";
import { useInventoryCommand } from "./useInventoryCommand";
interface Catalog {items:{itemId:number;name:string;conversion:UnitConversionSnapshot}[];scope:string}
interface RequestRow {id:string;version:number;status:string;document:RequestRevision}
const labels:Record<string,string>={submitted:"بانتظار الاعتماد",approved:"معتمد",partially_approved:"معتمد جزئيًا",rejected:"مرفوض"};
const english:Record<string,string>={
  "بانتظار الاعتماد": "Awaiting approval",
  "معتمد": "Approved",
  "معتمد جزئيًا": "Partially approved",
  "مرفوض": "Rejected",
  "طلبات شراء المواد": "Material purchase requests",
  "الطلب والاعتماد والتوريد حالات مستقلة": "Request, approval, and supply are independent states",
  "المخزون": "Inventory",
  "التقييم والطباعة": "Valuation & print",
  "مراجعة واعتماد الطلبات": "Review & approve requests",
  "أوامر الشراء والاستلام والمطابقة": "Purchase orders, receipts & matching",
  "تحديث": "Refresh",
  "جارٍ تحميل الطلبات…": "Loading requests…",
  "طلب جديد": "New request",
  "سبب الاحتياج": "Need reason",
  "بند": "Line",
  "المادة والعبوة": "Material and package",
  "اختر مادة ووحدة": "Select material and unit",
  "الكمية": "Quantity",
  "حذف البند": "Remove line",
  "تحتاج الإدارة لتسجيل وحدات العبوات المعتمدة قبل تقديم الطلب.": "Administration must register approved package conversions before submitting a request.",
  "إضافة مادة": "Add material",
  "جارٍ تقديم الطلب…": "Submitting request…",
  "تقديم طلب الشراء": "Submit purchase request",
  "إعادة تأكيد الطلب نفسه": "Confirm the same request again",
  "طلبات للمراجعة": "Requests for review",
  "طلباتي": "My requests",
  "إصدار": "Version",
  "بنود": "lines",
  "الاسم الحالي": "Current name",
  "لا توجد طلبات في هذا النطاق.": "No requests in this scope.",
  "صفحة": "Page",
  "السابق": "Previous",
  "التالي": "Next",
  "اكتب سبب الطلب وأضف مادة واحدة على الأقل.": "Enter the request reason and add at least one material.",
  "اختر المادة والوحدة لكل بند.": "Select the material and unit for each line.",
  "تعذّر تأكيد النتيجة. أعد المحاولة.": "Could not confirm the result. Please retry.",
  "تعذّر تحميل الطلبات. أعد المحاولة.": "Requests unavailable. Please retry.",
  "تعذّر التحميل": "Unavailable",
  "تم تقديم الطلب. لم يتغير المخزون أو حساب المورد. تقدير القيمة واعتماد الأمر خطوة مستقلة لدى الإدارة.": "Request submitted. Inventory and supplier balances are unchanged. Value estimation and order approval are separate administrative steps.",
  "تعذّر تأكيد النتيجة. أعد تأكيد العملية نفسها؛ تبقى المدخلات محفوظة حتى تتأكد النتيجة.": "The result could not be confirmed. Confirm the same operation again; inputs stay preserved until the result is known.",
  "لم تُقبل العملية. راجع المدخلات والصلاحية.": "The operation was refused. Check inputs and permission.",
};
export function ProcurementRequests(){
 const session=useSession();return <ProcurementRequestForm key={`${session?.username ?? "none"}:${session?.role ?? "none"}`} session={session}/>;
}
function ProcurementRequestForm({session}:{session:SessionInfo|null}){
 const [locale,setLocale]=useState<"ar"|"en">("ar");const text=(value:string)=>locale==="en"?(english[value]??value):value;
 const [reload,setReload]=useState(0);const [page,setPage]=useState(0);
 const [read,setRead]=useState<{owner:string;catalog:Catalog;items:RequestRow[];itemNames:Record<string,string>;hasMore:boolean}|null>(null);
 const [failed,setFailed]=useState<{owner:string;message:string}|null>(null);const [lines,setLines]=useState<{id:string;catalogIndex:string;quantity:string}[]>([]);
 const [reason,setReason]=useState("");const command=useInventoryCommand();const busy=command.locked;const [feedback,setFeedback]=useState("");const [fieldError,setFieldError]=useState("");
 const dirty=Boolean(reason.trim()||lines.length);
 useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty]);
 const firstField=useRef<HTMLTextAreaElement>(null);
 const owner=`${session?.username ?? "none"}:${page}:${reload}`;
 useEffect(()=>{if(!session)return;let alive=true;const controller=new AbortController();Promise.all([
  fetch("/api/inventory/procurement?view=catalog",{cache:"no-store",signal:controller.signal}),fetch(`/api/inventory/procurement?offset=${page*20}`,{cache:"no-store",signal:controller.signal})
 ]).then(async responses=>{const values=await Promise.all(responses.map(r=>r.json()));if(responses.some(r=>!r.ok))throw new Error(values.find((_,i)=>!responses[i].ok)?.message ?? "تعذّر التحميل");if(alive){setRead({owner,catalog:values[0],...values[1]});setFailed(null);}}).catch(error=>{if(alive)setFailed({owner,message:error instanceof Error?error.message:"تعذّر تحميل الطلبات. أعد المحاولة."});});return()=>{alive=false;controller.abort();};},[session,owner,page]);
 const data=read?.owner===owner?read:null;const error=failed?.owner===owner?failed.message:null;
 const addLine=()=>setLines(current=>[...current,{id:crypto.randomUUID(),catalogIndex:"",quantity:""}]);
 const edited=()=>{setFieldError("");setFeedback("");};
 async function submit(event:React.FormEvent){event.preventDefault();if(command.locked||!data||!session)return;setFieldError("");
  try{if(!reason.trim()||!lines.length)throw new Error("اكتب سبب الطلب وأضف مادة واحدة على الأقل.");
   const normalized=lines.map(line=>{const selected=data.catalog.items[Number(line.catalogIndex)];if(!selected||line.catalogIndex==="")throw new Error("اختر المادة والوحدة لكل بند.");const quantity=convertQuantity(line.quantity,selected.conversion);return {id:line.id,itemId:selected.itemId,quantity:quantity.enteredQuantity,conversion:quantity.conversion};});
   const document:RequestRevision={id:crypto.randomUUID(),version:1,branchId:data.catalog.scope,requestedBy:0,reason:reason.trim(),proposedSupplierPartyId:null,value:null,lines:normalized};
   const result=await command.send("request.submit",{document});if(result)complete();

  }catch(error){setFieldError(error instanceof Error?error.message:"تعذّر تأكيد النتيجة. أعد المحاولة.");firstField.current?.focus();}
 }
 const complete=()=>{setReason("");setLines([]);setFeedback("تم تقديم الطلب. لم يتغير المخزون أو حساب المورد. تقدير القيمة واعتماد الأمر خطوة مستقلة لدى الإدارة.");setPage(0);setReload(value=>value+1);};
 return <section className={`${styles.root} space-y-5`} dir={locale==="ar"?"rtl":"ltr"} lang={locale} data-testid="inventory-procurement">
  <div className={styles.toolbar}><div><h1 className={styles.title}>{text("طلبات شراء المواد")}</h1><p className={styles.caption}>{text("الطلب والاعتماد والتوريد حالات مستقلة")}</p></div><Link className={styles.button} href="/inventory">{text("المخزون")}</Link></div>
  <div className={styles.actions}><button type="button" className={styles.button} disabled={busy} onClick={()=>setLocale(locale==="ar"?"en":"ar")}><Languages size={16} aria-hidden="true"/>{locale==="ar"?"English":"العربية"}</button><Link className={styles.button} href="/inventory/review">{text("التقييم والطباعة")}</Link>{session?.role==="admin"?<><Link className={styles.button} href="/inventory/procurement/review">{text("مراجعة واعتماد الطلبات")}</Link><Link className={styles.button} href="/inventory/procurement/operations">{text("أوامر الشراء والاستلام والمطابقة")}</Link></>:null}<button className={styles.button} type="button" onClick={()=>setReload(value=>value+1)} disabled={busy}><RefreshCw size={16} aria-hidden="true"/>{text("تحديث")}</button></div>
  {error?<p className={styles.feedback} role="alert">{text(error)}</p>:!data?<p className={styles.feedback} role="status">{text("جارٍ تحميل الطلبات…")}</p>:<>
   <div className={styles.panel}><h2 className={styles.panelHeading}><span>{text("طلب جديد")}</span><PackagePlus size={18} aria-hidden="true"/></h2>
    <form noValidate onSubmit={submit} className="space-y-4 p-4">
     <label className="block text-sm font-semibold" htmlFor="procurement-reason">{text("سبب الاحتياج")}</label>
     <textarea ref={firstField} id="procurement-reason" rows={3} maxLength={2000} value={reason} disabled={busy} onChange={event=>{edited();setReason(event.target.value);}} className="w-full resize-none rounded-lg border border-blue-100 p-3" aria-invalid={Boolean(fieldError)} aria-describedby={fieldError?"procurement-error":undefined}/>
     {lines.map((line,index)=><fieldset key={line.id} className="grid gap-3 rounded-lg border border-blue-100 p-3 sm:grid-cols-[1fr_120px_auto]"><legend className="px-2 text-xs">{text("بند")} {index+1}</legend>
      <label className="text-sm">{text("المادة والعبوة")}<select className="mt-1 block w-full rounded border border-blue-100 p-2" value={line.catalogIndex} disabled={busy} onChange={event=>{edited();setLines(current=>current.map(row=>row.id===line.id?{...row,catalogIndex:event.target.value}:row));}}><option value="">{text("اختر مادة ووحدة")}</option>{data.catalog.items.map((item,i)=><option key={`${item.itemId}:${item.conversion.version}`} value={i}>{item.name} — {item.conversion.enteredUnit} ({item.conversion.baseUnitsPerEnteredUnit} {item.conversion.baseUnit})</option>)}</select></label>
      <label className="text-sm">{text("الكمية")}<input className="mt-1 block w-full rounded border border-blue-100 p-2" inputMode="decimal" value={line.quantity} disabled={busy} onChange={event=>{edited();setLines(current=>current.map(row=>row.id===line.id?{...row,quantity:event.target.value}:row));}}/></label>
      <button type="button" className={styles.button} aria-label={`${text("حذف البند")} ${index+1}`} disabled={busy} onClick={()=>{edited();setLines(current=>current.filter(row=>row.id!==line.id));}}><X size={16} aria-hidden="true"/></button>
     </fieldset>)}
     {!data.catalog.items.length?<p>{text("تحتاج الإدارة لتسجيل وحدات العبوات المعتمدة قبل تقديم الطلب.")}</p>:null}
     <div className={styles.actions}><button type="button" className={styles.button} disabled={busy||!data.catalog.items.length||lines.length>=100} onClick={()=>{edited();addLine();}}><Plus size={16} aria-hidden="true"/>{text("إضافة مادة")}</button><button className={`${styles.button} ${styles.primary}`} disabled={busy||!data.catalog.items.length} type="submit" aria-busy={command.busy}><Send size={16} aria-hidden="true"/>{command.busy?text("جارٍ تقديم الطلب…"):text("تقديم طلب الشراء")}</button></div>
     {command.message?<p role="alert" className="text-sm text-red-800">{text(command.message)}</p>:null}
     {command.status==="uncertain"?<button type="button" className={styles.button} onClick={async()=>{if(await command.retry())complete();}}>{text("إعادة تأكيد الطلب نفسه")}</button>:null}
     {fieldError?<p id="procurement-error" role="alert" className="text-sm text-red-800">{text(fieldError)}</p>:null}
     {feedback?<p role="status" className="text-sm text-green-800">{text(feedback)}</p>:null}
    </form>
   </div>
   <div className={styles.panel}><h2 className={styles.panelHeading}><span>{session?.role==="admin"?text("طلبات للمراجعة"):text("طلباتي")}</span><ClipboardCheck size={18} aria-hidden="true"/></h2><div className={styles.items}>{data.items.map(row=><article className={styles.item} key={row.id}><span className={styles.badge} data-state={row.status==="approved"?"known":"estimated"}>{text(labels[row.status]??row.status)}</span><h3 className="mt-2 font-semibold">{row.document.reason}</h3><p className={styles.caption}>{text("إصدار")} {row.version} · {row.document.lines.length} {text("بنود")}</p><ul className="mt-3 space-y-2 text-sm">{row.document.lines.map(line=><li key={line.id}><span className="block mb-1">{data.itemNames[line.itemId]??(locale==="ar"?`مادة #${line.itemId}`:`Item #${line.itemId}`)} · {text("الاسم الحالي")}</span><span dir="ltr" className="inline-flex items-center gap-1"><bdi>{line.quantity} {line.conversion.enteredUnit}</bdi><span>=</span><bdi>{convertQuantity(line.quantity,line.conversion).baseQuantity} {line.conversion.baseUnit}</bdi></span></li>)}</ul></article>)}</div>{!data.items.length?<p className={styles.note}>{text("لا توجد طلبات في هذا النطاق.")}</p>:null}<div className={`${styles.toolbar} ${styles.note}`}><span>{text("صفحة")} {page+1}</span><div className={styles.actions}><button className={styles.button} disabled={!page} type="button" onClick={()=>setPage(value=>value-1)}>{text("السابق")}</button><button className={styles.button} disabled={!data.hasMore} type="button" onClick={()=>setPage(value=>value+1)}>{text("التالي")}</button></div></div></div>
  </>}
 </section>;
}
