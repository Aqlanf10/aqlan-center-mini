"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PackagePlus, Plus, Send, X, RefreshCw, ClipboardCheck } from "lucide-react";
import { useSession, type SessionInfo } from "@/components/SessionProvider";
import { convertQuantity, type UnitConversionSnapshot } from "@/lib/inventory-domain/quantities";
import type { RequestRevision } from "@/lib/inventory-domain/procurement";
import styles from "./inventory.module.css";
import { useInventoryCommand } from "./useInventoryCommand";
interface Catalog {items:{itemId:number;name:string;conversion:UnitConversionSnapshot}[];scope:string}
interface RequestRow {id:string;version:number;status:string;document:RequestRevision}
const labels:Record<string,string>={submitted:"بانتظار الاعتماد",approved:"معتمد",partially_approved:"معتمد جزئيًا",rejected:"مرفوض"};
export function ProcurementRequests(){
 const session=useSession();return <ProcurementRequestForm key={`${session?.username ?? "none"}:${session?.role ?? "none"}`} session={session}/>;
}
function ProcurementRequestForm({session}:{session:SessionInfo|null}){
 const [reload,setReload]=useState(0);const [page,setPage]=useState(0);
 const [read,setRead]=useState<{owner:string;catalog:Catalog;items:RequestRow[];hasMore:boolean}|null>(null);
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
 return <section className={`${styles.root} space-y-5`} dir="rtl" data-testid="inventory-procurement">
  <div className={styles.toolbar}><div><h1 className={styles.title}>طلبات شراء المواد</h1><p className={styles.caption}>الطلب والاعتماد والتوريد حالات مستقلة</p></div><Link className={styles.button} href="/inventory">المخزون</Link></div>
  <div className={styles.actions}><Link className={styles.button} href="/inventory/review">التقييم والطباعة</Link><button className={styles.button} type="button" onClick={()=>setReload(value=>value+1)} disabled={busy}><RefreshCw size={16} aria-hidden="true"/>تحديث</button></div>
  {error?<p className={styles.feedback} role="alert">{error}</p>:!data?<p className={styles.feedback} role="status">جارٍ تحميل الطلبات…</p>:<>
   <div className={styles.panel}><h2 className={styles.panelHeading}><span>طلب جديد</span><PackagePlus size={18} aria-hidden="true"/></h2>
    <form noValidate onSubmit={submit} className="space-y-4 p-4">
     <label className="block text-sm font-semibold" htmlFor="procurement-reason">سبب الاحتياج</label>
     <textarea ref={firstField} id="procurement-reason" rows={3} maxLength={2000} value={reason} disabled={busy} onChange={event=>{edited();setReason(event.target.value);}} className="w-full resize-none rounded-lg border border-blue-100 p-3" aria-invalid={Boolean(fieldError)} aria-describedby={fieldError?"procurement-error":undefined}/>
     {lines.map((line,index)=><fieldset key={line.id} className="grid gap-3 rounded-lg border border-blue-100 p-3 sm:grid-cols-[1fr_120px_auto]"><legend className="px-2 text-xs">بند {index+1}</legend>
      <label className="text-sm">المادة والعبوة<select className="mt-1 block w-full rounded border border-blue-100 p-2" value={line.catalogIndex} disabled={busy} onChange={event=>{edited();setLines(current=>current.map(row=>row.id===line.id?{...row,catalogIndex:event.target.value}:row));}}><option value="">اختر مادة ووحدة</option>{data.catalog.items.map((item,i)=><option key={`${item.itemId}:${item.conversion.version}`} value={i}>{item.name} — {item.conversion.enteredUnit} ({item.conversion.baseUnitsPerEnteredUnit} {item.conversion.baseUnit})</option>)}</select></label>
      <label className="text-sm">الكمية<input className="mt-1 block w-full rounded border border-blue-100 p-2" inputMode="decimal" value={line.quantity} disabled={busy} onChange={event=>{edited();setLines(current=>current.map(row=>row.id===line.id?{...row,quantity:event.target.value}:row));}}/></label>
      <button type="button" className={styles.button} aria-label={`حذف البند ${index+1}`} disabled={busy} onClick={()=>{edited();setLines(current=>current.filter(row=>row.id!==line.id));}}><X size={16} aria-hidden="true"/></button>
     </fieldset>)}
     {!data.catalog.items.length?<p>تحتاج الإدارة لتسجيل وحدات العبوات المعتمدة قبل تقديم الطلب.</p>:null}
     <div className={styles.actions}><button type="button" className={styles.button} disabled={busy||!data.catalog.items.length||lines.length>=100} onClick={()=>{edited();addLine();}}><Plus size={16} aria-hidden="true"/>إضافة مادة</button><button className={`${styles.button} ${styles.primary}`} disabled={busy||!data.catalog.items.length} type="submit" aria-busy={command.busy}><Send size={16} aria-hidden="true"/>{command.busy?"جارٍ تقديم الطلب…":"تقديم طلب الشراء"}</button></div>
     {command.message?<p role="alert" className="text-sm text-red-800">{command.message}</p>:null}
     {command.status==="uncertain"?<button type="button" className={styles.button} onClick={async()=>{if(await command.retry())complete();}}>إعادة تأكيد الطلب نفسه</button>:null}
     {fieldError?<p id="procurement-error" role="alert" className="text-sm text-red-800">{fieldError}</p>:null}
     {feedback?<p role="status" className="text-sm text-green-800">{feedback}</p>:null}
    </form>
   </div>
   <div className={styles.panel}><h2 className={styles.panelHeading}><span>{session?.role==="admin"?"طلبات للمراجعة":"طلباتي"}</span><ClipboardCheck size={18} aria-hidden="true"/></h2><div className={styles.items}>{data.items.map(row=><article className={styles.item} key={row.id}><span className={styles.badge} data-state={row.status==="approved"?"known":"estimated"}>{labels[row.status]??row.status}</span><h3 className="mt-2 font-semibold">{row.document.reason}</h3><p className={styles.caption}>إصدار {row.version} · {row.document.lines.length} بنود</p><ul className="mt-3 space-y-2 text-sm">{row.document.lines.map(line=><li key={line.id}><span dir="ltr" className="inline-flex items-center gap-1"><bdi>{line.quantity} {line.conversion.enteredUnit}</bdi><span>=</span><bdi>{convertQuantity(line.quantity,line.conversion).baseQuantity} {line.conversion.baseUnit}</bdi></span></li>)}</ul></article>)}</div>{!data.items.length?<p className={styles.note}>لا توجد طلبات في هذا النطاق.</p>:null}<div className={`${styles.toolbar} ${styles.note}`}><span>صفحة {page+1}</span><div className={styles.actions}><button className={styles.button} disabled={!page} type="button" onClick={()=>setPage(value=>value-1)}>السابق</button><button className={styles.button} disabled={!data.hasMore} type="button" onClick={()=>setPage(value=>value+1)}>التالي</button></div></div></div>
  </>}
 </section>;
}
