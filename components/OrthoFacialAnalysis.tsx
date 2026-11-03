"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { clinicalContextHref } from "@/lib/patient-navigation";
import { FACIAL_LANDMARKS, blankFacialContent, computeFacialResults, readFacialCommand, type FacialCommand, type FacialContent, type FacialLandmark, type FacialResults } from "@/lib/ortho-facial-analysis";
import { readFacialRead, verifyFacialSaved, type FacialRead } from "@/lib/ortho-facial-records";
const control="min-h-11 min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
type Draft={documentId:number;expectedHeadId:number|null;content:FacialContent;reason:string};
export function OrthoFacialAnalysis({patientId,orthoCaseId}:{patientId:number;orthoCaseId:number}){
  const session=useSession(),authority=JSON.stringify([session?.username,session?.role,session?.permissions??null]);
  return <Workspace key={`${patientId}:${orthoCaseId}:${authority}`} patientId={patientId} orthoCaseId={orthoCaseId}/>;
}
function Results({results}:{results:FacialResults}){
  return <section aria-label="نتائج قياسات الوجه" className="space-y-3">{results.measures.map(m=><div key={m.id} className="rounded-lg border p-3">
    <h3 className="font-bold">{{thirds:"أثلاث الوجه",fifths_postaurale:"أخماس الوجه — حدود الأذن Pa",lower_third:"نسب الجزء السفلي",eye_widths:"عرض العينين والمسافة بينهما"}[m.id]}</h3>
    <p className="text-xs text-slate-600">{m.message}</p>
    {m.state==="ready"&&<ul className="mt-2 space-y-1 text-sm">{m.segments.map((s,i)=><li key={i} className="flex flex-wrap justify-between gap-2"><span>{s.label}</span><span dir="ltr">{s.percent.toFixed(1)}% · {s.pixels.toFixed(1)} px</span></li>)}</ul>}
  </div>)}</section>;
}
function Workspace({patientId,orthoCaseId}:{patientId:number;orthoCaseId:number}){
  const [documentId,setDocumentId]=useState<number|null>(null),[refresh,setRefresh]=useState(0),[historyId,setHistoryId]=useState<number|null>(null);
  const generation=useMemo(()=>({documentId,refresh}),[documentId,refresh]),committed=useRef<object|null>(null);
  useLayoutEffect(()=>{committed.current=generation;return()=>{if(committed.current===generation)committed.current=null;};},[generation]);
  const current=()=>committed.current===generation;
  const [read,setRead]=useState<{generation:object;data:FacialRead|null;error:string|null}|null>(null);
  const data=read?.generation===generation?read.data:null,error=read?.generation===generation?read.error:null;
  const [draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState<FacialCommand|null>(null),[busy,setBusy]=useState(false),busyRef=useRef(false);
  const [uncertain,setUncertain]=useState(false),[message,setMessage]=useState<string|null>(null),[denied,setDenied]=useState(false);
  const [selected,setSelected]=useState<FacialLandmark>("axisTop"),[unavailableReason,setUnavailableReason]=useState("");
  const [loaded,setLoaded]=useState<string|null>(null);
  const head=data?.history[0]??null,revision=data?.history.find(r=>r.id===historyId)??head;
  const stale=!!draft&&!!data&&draft.expectedHeadId!==(head?.id??null);
  const editable=!!data?.canWrite&&!!draft&&!busy&&!pending&&!denied&&!stale;
  const content=draft?.documentId===documentId?draft.content:revision?.command.content??null;
  const image=data?.image??null,imageKey=image&&documentId?`${documentId}:${image.sha256}:${image.width}:${image.height}`:null;
  const imageReady=imageKey!==null&&loaded===imageKey;
  const endpoint=`/api/ortho/${orthoCaseId}/facial-analysis`;
  useEffect(()=>{
    const controller=new AbortController();let live=true;
    const valid=()=>live&&!controller.signal.aborted&&committed.current===generation;
    const timer=setTimeout(()=>{if(valid()){setRead({generation,data:null,error:"تعذّرت القراءة؛ لا يعني ذلك أن السجل فارغ."});controller.abort();}},15000);
    void(async()=>{try{
      const response=await fetch(`${endpoint}?patientId=${patientId}${documentId===null?"":`&documentId=${documentId}`}`,{cache:"no-store",signal:controller.signal});
      if(!valid())return;if([401,403].includes(response.status)){setDenied(true);throw Error("الصورة وقياساتها محجوبة بالصلاحية الحالية.");}
      if(!response.ok||response.redirected)throw Error("تعذّر التحقق من الصورة وسجلها؛ راجع ربطها بالحالة وصلاحية الملف.");
      const accepted=await readFacialRead(await response.json(),{patientId,orthoCaseId},documentId);
      if(valid())setRead({generation,data:accepted,error:null});
    }catch(e){if(valid())setRead({generation,data:null,error:e instanceof Error?e.message:"تعذّرت القراءة."});}finally{clearTimeout(timer);}})();
    return()=>{live=false;controller.abort();clearTimeout(timer);};
  },[generation,documentId,patientId,orthoCaseId,endpoint]);
  useEffect(()=>{if(!draft&&!pending)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);},[draft,pending]);
  const change=(next:FacialContent, reviewing=false)=>{if(current()&&editable&&!busyRef.current)setDraft(d=>d&&({...d,content:reviewing?next:{...next,review:{state:"draft",note:next.review.note}}}));};
  const changePoint=(key:FacialLandmark,x:number,y:number)=>{
    if(!editable||!imageReady||!content||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return;
    change({...content,landmarks:{...content.landmarks,[key]:{state:"located",x,y}},review:{state:"draft",note:""}});
  };
  const pointer=(event:React.PointerEvent<SVGSVGElement>)=>{
    if(!editable||!imageReady||event.type==="pointermove"&&event.buttons!==1)return;
    const bounds=event.currentTarget.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    if(event.type==="pointerdown")event.currentTarget.setPointerCapture(event.pointerId);
    changePoint(selected,(event.clientX-bounds.left)/bounds.width,(event.clientY-bounds.top)/bounds.height);
  };
  function begin(){
    if(!current()||!data?.canWrite||!image||documentId===null||draft||pending||busyRef.current||denied||revision&&revision.id!==head?.id)return;
    const content=head?structuredClone(head.command.content):blankFacialContent(image);
    if(head&&canonicalJourneyJSON(content.image)!==canonicalJourneyJSON(image)){setMessage("أصل الصورة لا يطابق المراجعة المحفوظة؛ لا يمكن نقل معالمها إلى الأصل الحالي.");return;}
    content.review={state:"draft",note:""};setDraft({documentId,expectedHeadId:head?.id??null,reason:"",content});setMessage(null);
  }
  async function save(retry=false){
    if(!current()||!data?.canWrite||!draft||denied||busyRef.current||!imageReady||retry&&!pending||!retry&&(!editable||stale))return;
    let command:FacialCommand;
    try{command=retry?pending!:readFacialCommand({schemaVersion:1,clientRequestId:crypto.randomUUID(),documentId:draft.documentId,expectedHeadId:draft.expectedHeadId,reason:draft.reason,content:draft.content});}
    catch{setMessage("أكمل سبب المراجعة ومصدر تاريخ الصورة. مراجعة الطبيب تتطلب فحص الجودة ونتيجة قابلة للحساب وملاحظة مكتوبة.");return;}
    setPending(command);setBusy(true);busyRef.current=true;setUncertain(false);setMessage(null);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({patientId,command}),signal:controller.signal});
      if(!current())return;
      if([401,403].includes(response.status)){setDenied(true);setMessage("انتهت صلاحية العمل؛ أعد تسجيل الدخول والتحقق من السجل.");return;}
      const raw:unknown=await response.json();if(!current())return;
      if(!response.ok&&!response.redirected&&[400,404,409,413].includes(response.status)){
        setPending(null);setMessage(typeof raw==="object"&&raw!==null&&"message"in raw&&typeof raw.message==="string"?raw.message:"لم يقبل الخادم المراجعة.");
        if(response.status===409||response.status===404)setRefresh(v=>v+1);return;
      }
      if(response.redirected||!response.ok)throw Error("uncertain");
      await verifyFacialSaved(raw,{patientId,orthoCaseId,clinicalCaseId:data.clinicalCaseId,actorId:data.actorId,command},response.status);
      if(!current())return;
      setDraft(null);setPending(null);setHistoryId(null);setMessage("حُفظت مراجعة الصورة ومعالمها ونتائجها.");setRefresh(v=>v+1);
    }catch{if(current()){setUncertain(true);setMessage("نتيجة الحفظ غير مؤكدة. احتُفظ بالطلب نفسه؛ لا تبدّل الصورة ولا تنشئ طلباً بديلاً.");}}
    finally{clearTimeout(timer);busyRef.current=false;if(current())setBusy(false);}
  }
  if(denied)return <p role="alert" className="rounded-xl border p-4">الصورة والتحليل محجوبان بالصلاحية الحالية. أعد تسجيل الدخول للتحقق.</p>;
  return <main dir="rtl" className="mx-auto max-w-7xl space-y-4 p-3" data-testid="ortho-facial-workspace">
    <header className="space-y-2"><a className="inline-flex min-h-11 items-center underline" href={clinicalContextHref(patientId,{orthoCaseId,pillar:"diagnostics"},"ortho")}>العودة إلى ملف حالة التقويم #{orthoCaseId}</a>
      <h1 className="text-xl font-bold">قياسات صورة الوجه</h1><p className="text-sm">حدد المعالم يدوياً على صورة أمامية في الراحة. النتائج نسب وإسقاطات ثنائية الأبعاد؛ تفسيرها للطبيب، ولا تتحول إلى تشخيص أو خطة تلقائياً.</p>
      <p className="text-xs text-slate-600">الأخماس هنا تستخدم حدود الأذن Postaurale. لا تُخلط بحدود الوجنة. اليمين واليسار المذكوران هما جهتا الصورة، ولا يحددان جهة المريض في صورة معكوسة.</p></header>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status" className="rounded-lg border bg-amber-50 p-3">{message}</p>}
    <div className="flex flex-wrap gap-2"><label className="min-w-0 flex-1">الصورة المرتبطة بالحالة<select aria-label="الصورة المرتبطة بالحالة" className={`${control} block w-full`} value={documentId??""} disabled={!data||busy||!!pending} onChange={e=>{
      if(!current()||busyRef.current||pending)return;if(draft&&!window.confirm("تجاهل مسودة القياسات غير المحفوظة لهذه الصورة؟"))return;
      setDraft(null);setHistoryId(null);setMessage(null);setLoaded(null);setDocumentId(e.target.value?Number(e.target.value):null);
    }}><option value="">اختر صورة…</option>{data?.documents.map(d=><option key={d.id} value={d.id}>{d.title} · {d.takenOn??"تاريخ الصورة غير مسجل"}</option>)}</select></label>
    <button className={control} disabled={busy||!!pending} onClick={()=>{if(current()&&!busyRef.current&&!pending)setRefresh(v=>v+1);}}>تحديث سجل الصور والقياسات</button></div>
    {!data&&!error&&<p role="status">جارٍ التحقق من مصادر الحالة…</p>}
    {data?.documentsTruncated&&<p>تعرض القائمة أحدث 100 صورة؛ قد توجد صور أقدم خارج القائمة.</p>}
    {data&&data.documents.length===0&&<p>لا توجد صورة متاحة مرتبطة بهذه الحالة. أضف الصورة من قسم الصور والأشعة في ملف الحالة.</p>}
    {data&&documentId&&image&&<>
      <div className="flex flex-wrap gap-2">{data.history.length>0&&<label>المراجعة المحفوظة<select aria-label="المراجعة المحفوظة" className={`${control} block`} value={revision?.id??""} disabled={!!draft||!!pending||busy} onChange={e=>{if(current()&&!draft&&!pending&&!busyRef.current)setHistoryId(Number(e.target.value));}}>
        {data.history.map(r=><option key={r.id} value={r.id}>نسخة {r.version} · {r.createdAt.slice(0,10)} · {r.createdBy}</option>)}</select></label>}
        {!draft&&<button className={control} disabled={!data.canWrite||!imageReady||!!pending||!!revision&&revision.id!==head?.id} onClick={begin}>{head?"فتح مراجعة جديدة من آخر نسخة":"بدء قياسات هذه الصورة"}</button>}
        {data.historyTruncated&&<p>تظهر أحدث 30 مراجعة لهذه الصورة؛ لا يعني ذلك حذف المراجعات الأقدم.</p>}</div>
      {stale&&<p role="alert">تغيرت آخر مراجعة؛ بقيت مسودتك مرتبطة بنسختها السابقة. راجع السجل ثم تجاهل المسودة صراحةً لفتح مراجعة جديدة.</p>}
      <p className="text-sm font-bold">{draft?"مسودة قياسات غير محفوظة":revision?`نسخة ${revision.version} محفوظة — ${revision.command.content.review.state==="reviewed"?"راجعها الطبيب":"بانتظار مراجعة الطبيب"}`:"لم تحفظ قياسات لهذه الصورة بعد"}</p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <div className="min-w-0 space-y-3">
          <div dir="ltr" className="relative w-full overflow-hidden rounded-xl border bg-slate-900" style={{aspectRatio:`${image.width} / ${image.height}`}}>
            <img key={imageKey} src={`/api/ortho/${orthoCaseId}/facial-image?patientId=${patientId}&documentId=${documentId}&sha256=${image.sha256}`} alt="أصل صورة الوجه باتجاه العرض المتحقق" className="h-full w-full object-contain"
              onLoad={event=>{if(!current())return;const img=event.currentTarget;if(img.naturalWidth===image.width&&img.naturalHeight===image.height)setLoaded(imageKey);else{setLoaded(null);setMessage("أبعاد الصورة المعروضة لا تطابق مصدر المعالم؛ التحرير متوقف.");}}}
              onError={()=>{if(current()){setLoaded(null);setMessage("تعذر عرض أصل الصورة؛ لا يمكن تحديد المعالم أو الحفظ حتى التحقق منه.");}}}/>
            <svg aria-label="لوحة معالم الوجه" viewBox={`0 0 ${image.width} ${image.height}`} className="absolute inset-0 h-full w-full touch-none" onPointerDown={pointer} onPointerMove={pointer}>
              {content&&Object.entries(content.landmarks).map(([key,p])=>p.state==="located"?<g key={key} pointerEvents="none"><circle cx={p.x*image.width} cy={p.y*image.height} r={Math.max(image.width/120,3)} fill={key===selected?"#fbbf24":"#22d3ee"} stroke="#111827" strokeWidth={Math.max(image.width/400,1)}/><text x={p.x*image.width+image.width/80} y={p.y*image.height} fill="white" stroke="#111827" strokeWidth={image.width/1500} fontSize={image.width/35}>{FACIAL_LANDMARKS.find(l=>l[0]===key)?.[1].split(" — ")[0]}</text></g>:null)}
              {content&&([['tr','gl','sn','sto','me'],['paImageLeft','exImageLeft','enImageLeft','enImageRight','exImageRight','paImageRight']] as FacialLandmark[][]).flatMap((group,groupIndex)=>group.map(key=>{
                const p=content.landmarks[key],a=content.landmarks.axisTop,b=content.landmarks.axisBottom;if(p?.state!=="located"||a?.state!=="located"||b?.state!=="located")return null;
                const dx=(b.x-a.x)*image.width,dy=(b.y-a.y)*image.height,len=Math.hypot(dx,dy);if(len<1)return null;
                const vx=groupIndex===0?dy/len:dx/len,vy=groupIndex===0?-dx/len:dy/len,span=Math.hypot(image.width,image.height);
                return <line key={key} x1={p.x*image.width-vx*span} y1={p.y*image.height-vy*span} x2={p.x*image.width+vx*span} y2={p.y*image.height+vy*span} stroke={groupIndex===0?"#fbbf24":"#67e8f9"} strokeWidth={Math.max(image.width/600,1)} strokeDasharray="8 5" pointerEvents="none"/>;
              }))}
            </svg>
          </div>
          {draft&&<><p className="text-sm">اختر المعلم ثم انقر أو اسحب على الصورة لتحديده وتصحيحه. الإحداثيات أدناه بالبكسل من الصورة الموجهة، وليست بالملليمتر.</p>
            <label className="block">المعلم الحالي<select aria-label="المعلم الحالي" className={`${control} block w-full`} value={selected} disabled={!editable} onChange={e=>{if(editable){setSelected(e.target.value as FacialLandmark);setUnavailableReason("");}}}>{FACIAL_LANDMARKS.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
            <p className="text-sm">{FACIAL_LANDMARKS.find(row=>row[0]===selected)?.[2]}</p>
            <PixelEditor key={`${selected}:${JSON.stringify(content?.landmarks[selected])}`} point={content?.landmarks[selected]} width={image.width} height={image.height} disabled={!editable||!imageReady} apply={(x,y)=>changePoint(selected,x/image.width,y/image.height)}/>

            <label className="block">سبب تعذر تحديد المعلم<input className={`${control} block w-full`} value={unavailableReason} disabled={!editable} onChange={e=>setUnavailableReason(e.target.value)} maxLength={500}/></label>
            <button className={control} disabled={!editable||!unavailableReason.trim()} onClick={()=>{if(content&&editable&&unavailableReason.trim())change({...content,landmarks:{...content.landmarks,[selected]:{state:"unavailable",reason:unavailableReason}},review:{state:"draft",note:""}});}}>تسجيل المعلم غير متاح</button>
          </>}
        </div>
        <div className="min-w-0 space-y-3">{content&&<Results results={draft?computeFacialResults(content):revision!.results}/>}
          {draft&&content&&<section aria-label="مصدر الصورة ومراجعة الطبيب" className="space-y-3 rounded-lg border p-3">
            <label className="block">مصدر تاريخ الصورة<select aria-label="مصدر تاريخ الصورة" className={`${control} block w-full`} value={content.occurrence.dateProvenance} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,dateProvenance:e.target.value as FacialContent["occurrence"]["dateProvenance"],occurredOn:null}})}>
              <option value="unknown">غير معلوم</option><option value="contemporaneous_record">موثق وقت التصوير</option><option value="retrospective_record">توثيق لاحق</option><option value="historical_source">مصدر تاريخي</option></select></label>
            {content.occurrence.dateProvenance!=="unknown"&&<label className="block">تاريخ التقاط الصورة<input className={`${control} block w-full`} type="date" value={content.occurrence.occurredOn??""} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,occurredOn:e.target.value||null}})}/></label>}
            <label className="block">توضيح مصدر التاريخ<input className={`${control} block w-full`} maxLength={1000} value={content.occurrence.sourceNote} disabled={!editable} onChange={e=>change({...content,occurrence:{...content.occurrence,sourceNote:e.target.value}})}/></label>
            <fieldset><legend className="font-bold">مراجعة جودة الصورة</legend>{([["frontalRest","الصورة أمامية وفي وضع الراحة"],["headPosition","راجعت وضع الرأس والميل والدوران"],["visibleLandmarks","المعالم المستخدمة ظاهرة بوضوح"],["perspectiveReviewed","راجعت المنظور والمسافة والعدسة وحدود المقارنة"]] as const).map(([key,label])=><label key={key} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!editable} checked={content.quality[key]} onChange={e=>change({...content,quality:{...content.quality,[key]:e.target.checked},review:{state:"draft",note:""}})}/>{label}</label>)}</fieldset>
            <label className="block">حدود الصورة أو المعالم<textarea className={`${control} block w-full`} maxLength={1000} disabled={!editable} value={content.quality.note} onChange={e=>change({...content,quality:{...content.quality,note:e.target.value},review:{state:"draft",note:""}})}/></label>
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={!editable} checked={content.review.state==="reviewed"} onChange={e=>change({...content,review:{...content.review,state:e.target.checked?"reviewed":"draft"}},true)}/>راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب</label>
            <label className="block">تفسير الطبيب وملاحظة المراجعة<textarea className={`${control} block w-full`} maxLength={2000} disabled={!editable} value={content.review.note} onChange={e=>change({...content,review:{...content.review,note:e.target.value}},true)}/></label>
            <label className="block">سبب حفظ هذه المراجعة<input className={`${control} block w-full`} maxLength={500} disabled={!editable} value={draft.reason} onChange={e=>{if(current()&&editable)setDraft({...draft,reason:e.target.value});}}/></label>
            <div className="flex flex-wrap gap-2"><button className={control} disabled={!editable||!imageReady} onClick={()=>void save()}>حفظ مراجعة قياسات الصورة</button>
              <button className={control} disabled={busy||!!pending} onClick={()=>{if(current()&&!busyRef.current&&!pending&&window.confirm("تجاهل مسودة قياسات الصورة غير المحفوظة؟")){setDraft(null);setMessage(null);}}}>تجاهل مسودة الصورة</button></div>
          </section>}
          {!draft&&revision&&<section className="space-y-2 rounded-lg border p-3"><p>المصدر: صورة #{revision.documentId} · {revision.command.content.occurrence.occurredOn??"تاريخ الصورة غير معلوم"}</p><p>{revision.command.content.occurrence.sourceNote}</p><p>حفظها {revision.createdBy} · {revision.createdAt}</p><p>{revision.command.reason}</p><ul className="text-sm">{([["frontalRest","صورة أمامية في الراحة"],["headPosition","وضع الرأس"],["visibleLandmarks","وضوح المعالم"],["perspectiveReviewed","المنظور والمسافة"]] as const).map(([key,label])=><li key={key}>{label}: {revision.command.content.quality[key]?"أكده الطبيب":"لم يؤكد"}</li>)}</ul><p>{revision.command.content.quality.note}</p><p>{revision.command.content.review.note}</p><dl className="space-y-1 text-sm">{FACIAL_LANDMARKS.map(([key,label])=>{const p=revision.command.content.landmarks[key];return <div key={key}><dt className="font-bold">{label}</dt><dd>{p?.state==="located"?`${(p.x*image.width).toFixed(1)}, ${(p.y*image.height).toFixed(1)} px`:p?.state==="unavailable"?`غير متاح: ${p.reason}`:"لم يحدد"}</dd></div>;})}</dl><p className="break-all text-xs">بصمة المراجعة: {revision.contentHash}</p></section>}
          {uncertain&&pending&&<div role="alert"><button className={control} disabled={busy||!data||!imageReady} onClick={()=>void save(true)}>التحقق بإعادة نفس طلب قياسات الصورة</button></div>}
        </div>
      </div>
    </>}
  </main>;
}

/** Both coordinates must be explicitly supplied; an omitted axis never becomes a guessed landmark. */
function PixelEditor({point,width,height,disabled,apply}:{point:FacialContent["landmarks"][FacialLandmark];width:number;height:number;disabled:boolean;apply:(x:number,y:number)=>void}){
  const px=point?.state==="located"?String(Number((point.x*width).toFixed(3))):"",py=point?.state==="located"?String(Number((point.y*height).toFixed(3))):"";
  const [x,setX]=useState(px),[y,setY]=useState(py);
  const valid=x.trim()!==""&&y.trim()!==""&&Number.isFinite(Number(x))&&Number.isFinite(Number(y))&&Number(x)>=0&&Number(x)<=width&&Number(y)>=0&&Number(y)<=height;
  return <div className="space-y-2"><div className="grid grid-cols-2 gap-2">{(["X","Y"] as const).map(axis=><label key={axis}>إحداثي {axis} بالبكسل<input aria-label={`إحداثي ${axis} بالبكسل`} className={`${control} w-full`} type="number" step="0.1" min="0" max={axis==="X"?width:height} disabled={disabled} value={axis==="X"?x:y} onChange={e=>(axis==="X"?setX:setY)(e.target.value)}/></label>)}</div><button className={control} disabled={disabled||!valid} onClick={()=>{if(!disabled&&valid)apply(Number(x),Number(y));}}>تطبيق الإحداثيين على المعلم</button></div>;
}
