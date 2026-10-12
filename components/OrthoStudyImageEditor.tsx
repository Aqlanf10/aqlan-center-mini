"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { canonicalOrthoMediaRecipe, parseOrthoMediaRecipe, parseOrthoStudyMediaUseDraft, planOrthoMediaGeometry, type OrthoMediaRecipe, type OrthoStudyMediaUseDraft } from "@/lib/ortho-study-media";
import { captureStudyImagePreview, captureStudyImagePreviewRequest, canvasRecipe, cropFromCanvasPoints, editorCanvasFrame, originalComparisonRecipe, pointOnCanvas, pushRecipeHistory, rotateAndResetCrop, startRecipeHistory, stepRecipeHistory, studyImageScopeKey, verifyStudyImagePreview, type EditorPoint, type RecipeHistory, type StudyImageEditRequest, type StudyImagePreviewRequest, type StudyImagePreviewResult } from "@/lib/ortho-study-image-editor";

export interface OrthoStudyImageEditorProps {
  /** Current case/principal/permission generation and local draft lifetime. */
  ownerKey: string; use: OrthoStudyMediaUseDraft; frame: { width: number; height: number }; editable: boolean;
  /** Synchronous owner/use/document/source/previous-recipe CAS into local draft.
   * True never means database save, clinical review or source verification. */
  onChange(request: StudyImageEditRequest): boolean;
  /** Parent owns current source authority, approved isolated processor and
   * sequential native admission. No external URL is accepted here. */
  requestPreview(request: StudyImagePreviewRequest): Promise<StudyImagePreviewResult>;
}
const control = "min-h-11 min-w-11 rounded border px-3 py-2 disabled:opacity-50";
const failures: Record<string, string> = {
  forbidden: "صلاحية معاينة الصورة غير متاحة الآن.", stale: "تغير مصدر الصورة؛ أعد فتح الاستخدام الحالي.",
  orientation_required: "اتجاه الصورة لم يُتحقق منه بعد.", size_limit: "تجاوزت المعاينة الحد الآمن. لم يُحذف الأصل ولم تُقلل الجودة تلقائيًا.",
  unavailable: "المعاينة غير متاحة الآن. يمكنك متابعة تعديل المسودة وحفظها في دراسة الحالة.", invalid: "تعذر التحقق من هوية المعاينة؛ لم تُعرض الصورة المستلمة.",
};
type View = StudyImagePreviewRequest["purpose"];
const cropStrings = (recipe: OrthoMediaRecipe) => ({ left: String(recipe.cropPpm.left / 10000), top: String(recipe.cropPpm.top / 10000), right: String(recipe.cropPpm.right / 10000), bottom: String(recipe.cropPpm.bottom / 10000) });
export default function OrthoStudyImageEditor(props: OrthoStudyImageEditorProps) {
  let use: OrthoStudyMediaUseDraft;
  try { use = parseOrthoStudyMediaUseDraft(props.use); } catch { return <p role="alert">بيانات استخدام الصورة غير صالحة.</p>; }
  const { width, height } = props.frame;
  if (!props.ownerKey || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 4_000_000) return <p role="alert">إطار المعاينة غير صالح.</p>;
  return <Editor key={studyImageScopeKey({ ownerKey: props.ownerKey, useId: use.useId, documentId: use.documentId, sourceSha256: use.sourceSha256 })} {...props} use={use} />;
}
function Editor(props: OrthoStudyImageEditorProps) {
  const recipe = props.use.recipe, canonical = canonicalOrthoMediaRecipe(recipe);
  const active = useRef(true), latest = useRef(props);
  const [historyView, setHistoryView] = useState<RecipeHistory>(() => startRecipeHistory(recipe));
  const history = useRef<RecipeHistory>(historyView), committedCanonical = useRef(canonical);
  const [notice, setNotice] = useState(""), [view, setView] = useState<View>("selected-use"), [zoom, setZoom] = useState(1), [retry, setRetry] = useState(0);
  const [aspect, setAspect] = useState<"free" | "slot">("free"), [rotation, setRotation] = useState(String(recipe.rotationMilliDegrees / 1000)), [crop, setCrop] = useState(() => cropStrings(recipe));
  const viewport = useRef<HTMLDivElement>(null);
  // Only committed props may authorize event callbacks; abandoned renders do not publish refs.
  useLayoutEffect(() => { latest.current = props; }, [props]);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLayoutEffect(() => {
    if (committedCanonical.current === canonical) return;
    committedCanonical.current = canonical;
    if (history.current.current !== canonical) history.current = startRecipeHistory(recipe);
    setHistoryView(history.current);
    setRotation(String(recipe.rotationMilliDegrees / 1000)); setCrop(cropStrings(recipe));
  }, [canonical, recipe]);
  const apply = (next: OrthoMediaRecipe, proposedHistory?: RecipeHistory) => {
    const now = latest.current;
    if (!active.current || now !== props || !now.editable || canonicalOrthoMediaRecipe(now.use.recipe) !== canonical) return false;
    let parsed: OrthoMediaRecipe;
    try { parsed = parseOrthoMediaRecipe(next); planOrthoMediaGeometry(parsed, now.frame); editorCanvasFrame(parsed); }
    catch { setNotice("يتجاوز التعديل حدود الهندسة الآمنة. لم تتغير المسودة."); return false; }
    const proposed = proposedHistory ?? pushRecipeHistory(history.current, canonical, parsed); if (!proposed) return false;
    if (!now.onChange({ ownerKey: now.ownerKey, useId: now.use.useId, documentId: now.use.documentId, sourceSha256: now.use.sourceSha256, expectedRecipe: canonical, recipe: parsed })) { setNotice("تغيرت المسودة؛ لم يُطبق التعديل القديم."); return false; }
    history.current = proposed; setHistoryView(proposed); setNotice("تم تعديل هذا الاستخدام في المسودة. احفظ دراسة الحالة لتثبيته."); return true;
  };
  const rotate = (degrees: number) => {
    if (!Number.isFinite(degrees) || !Number.isSafeInteger(Math.round(degrees * 1000))) { setNotice("أدخل زاوية واضحة بالدرجات."); return; }
    if (apply(rotateAndResetCrop(recipe, Math.round(degrees * 1000)))) setView("editor-canvas");
  };
  const applyCrop = () => {
    if (Object.values(crop).some(value => !/^\d+(\.\d{1,4})?$/.test(value) || Number(value) > 100)) { setNotice("حدود القص من 0 إلى 100% مع نقطة عشرية واضحة."); return; }
    try { apply(parseOrthoMediaRecipe({ ...recipe, cropPpm: Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, Math.round(Number(value) * 10000)])) })); }
    catch { setNotice("اليسار يجب أن يسبق اليمين والأعلى يجب أن يسبق الأسفل."); }
  };
  let previewRecipe = recipe, frame = props.frame, geometryError = false;
  try { planOrthoMediaGeometry(recipe, frame); previewRecipe = view === "editor-canvas" ? canvasRecipe(recipe) : view === "original-comparison" ? originalComparisonRecipe(recipe) : recipe; if (view === "editor-canvas") frame = editorCanvasFrame(recipe); }
  catch { geometryError = true; }
  const previewKey = JSON.stringify([view, canonicalOrthoMediaRecipe(previewRecipe), frame.width, frame.height, retry]);
  const request = captureStudyImagePreviewRequest({ ownerKey: props.ownerKey, useId: props.use.useId, documentId: props.use.documentId, sourceSha256: props.use.sourceSha256,
    purpose: view, recipe: previewRecipe, frame, signal: new AbortController().signal });
  return <section lang="ar" dir="rtl" aria-label="محرر استخدام الصورة" className="min-w-0 space-y-3 rounded border p-3">
    <h3 className="font-semibold">تعديل صورة الدراسة</h3>
    <p className="text-sm">التعديلات تخص هذا الاستخدام فقط؛ الأصل وقياسات السيفالومتري لا تتغير. المعاينة ليست مراجعة سريرية.</p>
    <div role="group" aria-label="وضع المعاينة" className="flex flex-wrap gap-2">{([['selected-use','إطار العرض'],['editor-canvas','تحديد القص'],['original-comparison','مقارنة بالأصل']] as const).map(([value,label]) => <button key={value} type="button" className={control} aria-pressed={view === value} onClick={() => { setView(value); setZoom(1); }}>{label}</button>)}</div>
    <div className="flex flex-wrap gap-2" aria-label="تكبير وتنقل للمعاينة فقط">
      <button type="button" className={control} disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}>تصغير</button>
      <button type="button" className={control} disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.5))}>تكبير</button><span>{Math.round(zoom * 100)}%</span>
      <button type="button" className={control} onClick={() => viewport.current?.scrollBy({ left: -100 })}>تحريك لليسار</button><button type="button" className={control} onClick={() => viewport.current?.scrollBy({ left: 100 })}>تحريك لليمين</button>
    </div>
    <div ref={viewport} dir="ltr" className="max-h-[32rem] min-h-32 overflow-auto rounded border bg-slate-100">
      {geometryError ? <p role="status">{failures.size_limit}</p> : <Preview key={previewKey} request={request} requestPreview={props.requestPreview} savedRecipe={recipe} editable={props.editable}
        zoom={zoom} aspect={aspect === "slot" ? props.frame.width / props.frame.height : undefined} onCrop={apply} onRetry={() => setRetry(value => value + 1)} />}
    </div>
    <fieldset disabled={!props.editable} className="min-w-0 space-y-3"><legend className="font-semibold">تعديلات الاستخدام</legend>
      <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={!historyView.before.length} onClick={() => { const h = stepRecipeHistory(history.current,"undo"); if (h) apply(parseOrthoMediaRecipe(JSON.parse(h.current)),h); }}>تراجع</button>
        <button type="button" className={control} disabled={!historyView.after.length} onClick={() => { const h = stepRecipeHistory(history.current,"redo"); if (h) apply(parseOrthoMediaRecipe(JSON.parse(h.current)),h); }}>إعادة</button>
        <button type="button" className={control} onClick={() => apply(originalComparisonRecipe(recipe))}>إعادة ضبط هذا الاستخدام</button></div>
      <p className="text-sm">التدوير وتصحيح الميل يعيدان حدود القص ووضع الاحتواء لمراجعة الاتجاه الجديد.</p>
      <div className="flex flex-wrap items-end gap-2"><button type="button" className={control} onClick={() => rotate(recipe.rotationMilliDegrees / 1000 - 90)}>تدوير −90° وإعادة القص</button><button type="button" className={control} onClick={() => rotate(recipe.rotationMilliDegrees / 1000 + 90)}>تدوير +90° وإعادة القص</button>
        <label>زاوية الميل بالدرجات<input className={`${control} block w-32`} dir="ltr" inputMode="decimal" value={rotation} onChange={event => setRotation(event.target.value)} /></label><button type="button" className={control} onClick={() => rotate(/^-?\d+(\.\d{1,3})?$/.test(rotation) ? Number(rotation) : NaN)}>تطبيق الميل وإعادة القص</button></div>
      <label className="block">نسبة التحديد<select className={`${control} ms-2`} value={aspect} onChange={event => setAspect(event.target.value as "free"|"slot")}><option value="free">حر</option><option value="slot">نسبة إطار العرض</option></select></label>
      <div className="flex flex-wrap items-end gap-2">{([['left','اليسار'],['top','الأعلى'],['right','اليمين'],['bottom','الأسفل']] as const).map(([key,label]) => <label key={key}>{label} %<input className={`${control} block w-24`} dir="ltr" inputMode="decimal" value={crop[key]} onChange={event => setCrop(value => ({ ...value,[key]:event.target.value }))} /></label>)}<button type="button" className={control} onClick={applyCrop}>تطبيق حدود القص</button></div>
      <label className="block">ملاءمة الإطار<select className={`${control} ms-2`} value={recipe.fit} onChange={event => apply({...recipe,fit:event.target.value as "contain"|"cover"})}><option value="contain">احتواء كامل</option><option value="cover">ملء الإطار بقص مركزي</option></select></label>
      {([['brightnessPermille','الإضاءة'],['contrastPermille','التباين']] as const).map(([key,label]) => <label key={key} className="block">{label} {recipe[key]/10}%<input aria-label={label} type="range" min={800} max={1200} step={10} value={recipe[key]} className="block min-h-11 w-full" onChange={event => apply({...recipe,[key]:Number(event.target.value)})} /></label>)}
    </fieldset><p role="status" className="text-sm">{notice}</p>
  </section>;
}
interface PreviewProps {
  request: StudyImagePreviewRequest; requestPreview: OrthoStudyImageEditorProps["requestPreview"]; savedRecipe: OrthoMediaRecipe;
  editable: boolean; zoom: number; aspect?: number; onCrop(recipe: OrthoMediaRecipe): boolean; onRetry(): void;
}
function Preview(props: PreviewProps) {
  const initial = useRef(props), current = useRef(props);
  useLayoutEffect(() => { current.current = props; }, [props]);
  const lifetime = useRef({ active: true, abort: new AbortController() });
  const [url,setUrl] = useState<string|null>(null), [error,setError] = useState<string|null>(null), [busy,setBusy] = useState(true), [drag,setDrag] = useState<{a:EditorPoint;b:EditorPoint}|null>(null);
  const pointer = useRef<{id:number;a:EditorPoint}|null>(null);
  useLayoutEffect(() => { const token = { active: true, abort: new AbortController() }; lifetime.current = token; return () => { token.active = false; token.abort.abort(); pointer.current = null; }; },[]);
  useEffect(() => {
    const token = lifetime.current, p = initial.current, request = captureStudyImagePreviewRequest({...p.request,signal:token.abort.signal}); let objectUrl:string|null = null;
    const valid = () => token.active && !token.abort.signal.aborted;
    const timer = setTimeout(() => { void (async () => {
      try { if (!valid()) return; const result = await p.requestPreview(request); if (!valid()) return;
        if (!result.ok) {setError(result.code);return;}
        const preview = captureStudyImagePreview(result.preview);
        if (!await verifyStudyImagePreview(preview,request)) {if(valid())setError("invalid");return;}
        if (!valid()) return; objectUrl = URL.createObjectURL(preview.blob); setUrl(objectUrl);
      } catch {if(valid())setError("unavailable");} finally {if(valid())setBusy(false);}
    })(); },180);
    return () => {clearTimeout(timer);token.abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[]);
  const canCrop = props.request.purpose === "editor-canvas" && props.editable && !!url && !error;
  const at = (event:PointerEvent<HTMLImageElement>) => pointOnCanvas(props.savedRecipe,props.request.frame,event.currentTarget.getBoundingClientRect(),{x:event.clientX,y:event.clientY});
  const start = (event:PointerEvent<HTMLImageElement>) => { if(!lifetime.current.active||current.current!==props||!canCrop||event.button!==0)return;const a=at(event);if(!a)return;pointer.current={id:event.pointerId,a};setDrag({a,b:a});event.currentTarget.setPointerCapture(event.pointerId);};
  const move = (event:PointerEvent<HTMLImageElement>) => {const p=pointer.current;if(!lifetime.current.active||current.current!==props||!p||p.id!==event.pointerId)return;const b=at(event);if(b)setDrag({a:p.a,b});};
  const end = (event:PointerEvent<HTMLImageElement>) => {if(!lifetime.current.active||current.current!==props)return;const p=pointer.current;if(!p||p.id!==event.pointerId)return;pointer.current=null;setDrag(null);if(!canCrop||!current.current.editable)return;const b=at(event);if(!b)return;const recipe=cropFromCanvasPoints(props.savedRecipe,p.a,b,props.aspect);if(recipe)current.current.onCrop(recipe);};
  const plan = planOrthoMediaGeometry(canvasRecipe(props.savedRecipe),props.request.frame);
  const crop = drag ? cropFromCanvasPoints(props.savedRecipe,drag.a,drag.b,props.aspect)?.cropPpm : props.savedRecipe.cropPpm;
  const rect = crop ? {x:plan.content.left+crop.left/1e6*plan.rotatedCanvas.width*plan.content.scale,y:plan.content.top+crop.top/1e6*plan.rotatedCanvas.height*plan.content.scale,width:(crop.right-crop.left)/1e6*plan.rotatedCanvas.width*plan.content.scale,height:(crop.bottom-crop.top)/1e6*plan.rotatedCanvas.height*plan.content.scale}:null;
  return <div aria-busy={busy}>{url&&!error?<div style={{position:"relative",width:`${props.zoom*100}%`}}>
    {/* eslint-disable-next-line @next/next/no-img-element -- verified local PNG blob; no remote clinical-image loader. */}
    <img src={url} alt={props.request.purpose==="original-comparison"?"مقارنة بالأصل دون تعديلات العرض":"معاينة استخدام الصورة"} width={props.request.frame.width} height={props.request.frame.height} draggable={false}
      style={{display:"block",width:"100%",height:"auto",touchAction:canCrop?"none":"auto"}} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={event=>{if(!lifetime.current.active||current.current!==props||pointer.current?.id!==event.pointerId)return;pointer.current=null;setDrag(null);}} />
    {props.request.purpose==="editor-canvas"&&rect&&<svg aria-hidden="true" viewBox={`0 0 ${props.request.frame.width} ${props.request.frame.height}`} style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}}><rect {...rect} fill="none" stroke="#2563eb" strokeWidth={2} vectorEffect="non-scaling-stroke" /></svg>}
  </div>:<p role="status" className="p-4">{busy?"جارٍ تجهيز المعاينة…":failures[error??"unavailable"]}</p>}{error&&<button type="button" className={control} onClick={()=>{if(lifetime.current.active)current.current.onRetry();}}>إعادة المعاينة</button>}</div>;
}
