import type {DbClient,Invoice} from "./db";
import {DebtRepaymentError} from "./debt-installments-db";
import {lineLinkage,siteText,toothScope,validateLineSite,caseSiteScope} from "./invoice-clinical-linkage";

export interface InvoiceIdentityAmendment {
  serviceId:number|null;doctorId:number|null;description:string;category:string|null;toothCode:number|null;surfaces:string|null;caseSite:string|null;
}
export async function invoiceIdentityCatalog(client:DbClient){
  const {rows:services}=await client.query<{id:number;name:string;category:string|null}>("SELECT id,name,category FROM services WHERE is_active ORDER BY id");
  const {rows:doctors}=await client.query<{id:number;name:string}>("SELECT id,name FROM parties WHERE kind='doctor' ORDER BY id");
  return {services,doctors};
}
function refuse(message:string):never{throw new DebtRepaymentError("conflict",message);}
const nullableId=(value:unknown):value is number|null=>value===null||typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<=2147483647;
/** Changes only unexecuted, unshared work with no receipt/source/commission
 * history. The old invoice and its approved clinical snapshot stay immutable. */
export async function validateInvoiceIdentityAmendments(client:DbClient,invoice:Invoice,lines:Record<string,unknown>[],
  work:readonly {id:number;clinical_locked:boolean;legacy:boolean;category:string|null;case_site:string|null}[],available:boolean){
  const amendments=new Map<number,InvoiceIdentityAmendment>();
  for(const line of lines){
    const old=invoice.items.find(item=>item.id===line.itemId);if(!old)continue;
    const serviceId=Object.hasOwn(line,"serviceId")?line.serviceId:old.serviceId;
    const doctorId=Object.hasOwn(line,"doctorId")?line.doctorId:old.doctorId;
    const toothCode=Object.hasOwn(line,"toothCode")?line.toothCode:old.toothCode??null;
    const surfaces=Object.hasOwn(line,"surfaces")?line.surfaces:old.surfaces??null;
    if(!nullableId(serviceId)||!nullableId(doctorId)||!nullableId(toothCode)||surfaces!==null&&typeof surfaces!=="string")refuse("راجع الخدمة والطبيب والسن والأسطح في التصحيح.");
    if(serviceId===old.serviceId&&doctorId===old.doctorId&&toothCode===(old.toothCode??null)&&surfaces===(old.surfaces??null))continue;
    const linked=work.find(row=>row.id===old.planItemId);
    if(!available||linked&&(linked.clinical_locked||linked.legacy)||old.financialReviewRequired)refuse("لا يمكن تغيير الخدمة أو الطبيب أو الموضع بعد تحصيل أو عمل/مسودة سريرية أو اعتماد عمولة؛ أبقِ الهوية وصحّح المبلغ فقط.");
    const {rows:[service]}=await client.query<{id:number;name:string;category:string|null}>("SELECT id,name,category FROM services WHERE id=$1 AND is_active FOR SHARE NOWAIT",[serviceId]);
    const {rows:[prior]}=await client.query<{category:string|null}>("SELECT category FROM services WHERE id=$1 FOR SHARE NOWAIT",[old.serviceId]);
    if(serviceId!==null&&!service||doctorId!==null&&!(await client.query("SELECT id FROM parties WHERE id=$1 AND kind='doctor' FOR SHARE NOWAIT",[doctorId])).rowCount)refuse("الخدمة أو الطبيب لم يعد متاحًا؛ حدّث التصحيح.");
    const category=service?.category??null,oldCategory=linked?.category??prior?.category??null;
    const previous=lineLinkage({serviceId:old.serviceId,category:oldCategory}),next=lineLinkage({serviceId,category});
    if(previous.kind!==next.kind||next.kind==="clinical"&&(previous.kind!=="clinical"||previous.specialty!==next.specialty||toothScope(oldCategory)!==toothScope(category)||oldCategory!==category))
      refuse("تغيير اختصاص العلاج أو وحدة تسعيره يحتاج خطة سريرية مستقلة؛ لم تُغيّر الفاتورة أو الحالة.");
    const scope=caseSiteScope(linked?.case_site);
    if(linked&&(old.quantity!==1||line.quantity!==1||!old.toothCode&&!scope||old.toothCode&&old.caseId!=null&&linked.case_site!==String(old.toothCode)))
      refuse("هذا العمل مشترك أو ذو نطاق جماعي غير قابل لإعادة التعريف؛ لم تتغيّر هويته.");
    if(linked&&doctorId===null)refuse("حدد الطبيب المعالج للعمل المصحح.");
    const site=validateLineSite({category,toothCode,surfaces,...(scope?{scope}:{})});
    if(!site.ok)refuse("السن أو الأسطح لا تطابق وحدة هذه الخدمة؛ لم تتغيّر هوية العلاج.");
    if(!linked&&site.site.mode!=="none")refuse("إضافة هوية سريرية لبند مالي تحتاج خطة مستقلة؛ لم يُنشأ علاج ضمني.");
    if(linked){
      const {rows:overlap}=await client.query("SELECT i.id FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 AND i.id<>$2 AND i.status<>'cancelled' AND i.category IS NOT DISTINCT FROM $3 AND i.tooth_code=$4 LIMIT 1",[invoice.patientId,linked.id,category,site.site.toothCode]);
      if(overlap.length)refuse("يوجد بند علاج آخر بهذا الموضع والاختصاص؛ لا ينشئ التصحيح علاجًا مكررًا ولا يدمج البنود تلقائيًا.");
    }
    amendments.set(old.id,{serviceId,doctorId,description:service?.name??old.description,category,toothCode:site.site.toothCode,surfaces:site.site.surfaces,caseSite:siteText(site.site)});
  }
  return amendments;
}
