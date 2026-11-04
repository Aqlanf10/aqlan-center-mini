/** Synthetic saved studies only. No image bytes, tracing engine, real patients or activation. */
import type { Pool } from "pg";
export async function seedCanonicalCeph(q: Pick<Pool,"query">, input: {patientId:number;status?:"draft"|"completed"|"discarded";documentId?:number;orthoCaseId?:number|null;value?:number}) {
  const documentId = input.documentId ?? (await q.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'imaging','SYN private image title','image/png',1,$2,'SYN/private.png','SYN') RETURNING id",[input.patientId,"b".repeat(64)])).rows[0].id;
  const status=input.status??"completed";
  const id=(await q.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,completed_by,completed_at,ortho_case_id,xray_date,note,device) VALUES($1,$2,$3,'SYN recorder',$4,$5,$6,'2024-02-29','SYN saved clinical note','SYN machine') RETURNING id",[input.patientId,documentId,status,status==="completed"?"SYN completer":null,status==="completed"?"2024-03-01T12:00:00Z":null,input.orthoCaseId??null])).rows[0].id;
  if(status==="completed")await q.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'ANB',$2),($1,'FMA',26.75),($1,'WITS',-1.125)",[id,input.value??3.125]);
  return {id:Number(id),documentId:Number(documentId),patientId:input.patientId};
}
