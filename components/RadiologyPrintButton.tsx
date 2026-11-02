"use client";
import { useLayoutEffect, useRef, useState } from 'react';
import { useSession } from './SessionProvider';
export function RadiologyPrintButton(props:{requestId:string;patientId:number}) {
 const session=useSession();
 return <AuthorizedRadiologyPrint key={JSON.stringify([props.requestId,props.patientId,session?.username,session?.role,session?.permissions])} {...props}/>;
}
function AuthorizedRadiologyPrint({requestId,patientId}:{requestId:string;patientId:number}) {
 const alive=useRef(true),latch=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const print=async()=>{if(!alive.current||latch.current)return;latch.current=true;setBusy(true);setError('');try{
  const response=await fetch(`/api/radiology-requests/${requestId}/print`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientId})});
  const body=await response.json();if(!alive.current)return;
  if(!response.ok||body.allowed!==true||body.id!==requestId||body.patientId!==patientId)throw new Error(body.message||'لم تُعتمد الطباعة؛ أعد فتح الملف للتحقق من الصلاحية.');
  window.print();
 }catch(e){if(alive.current)setError(e instanceof Error?e.message:'تعذرت الطباعة.');}finally{latch.current=false;if(alive.current)setBusy(false);}};
 return <div className="print-actions"><button data-print-document-action type="button" disabled={busy} onClick={()=>void print()}>{busy?'التحقق من صلاحية الطباعة…':'طباعة طلب الأشعة'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
