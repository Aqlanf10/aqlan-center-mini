import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultOrthoMediaRecipe, canonicalOrthoMediaRecipe } from "../lib/ortho-study-media";
import { captureStudyImagePreview, captureStudyImagePreviewRequest, canvasRecipe, originalComparisonRecipe, rotateAndResetCrop, editorCanvasFrame,
  pointOnCanvas, cropFromCanvasPoints, startRecipeHistory, pushRecipeHistory, stepRecipeHistory, studyImageScopeKey,
  verifyStudyImagePreview, type StudyImagePreviewRequest, type StudyImagePreview } from "../lib/ortho-study-image-editor";
const recipe = () => defaultOrthoMediaRecipe(800, 400, 1);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function request(): StudyImagePreviewRequest {
  return { ownerKey: "case1-principal1-generation1", useId: "use1", documentId: 1, sourceSha256: "a".repeat(64),
    purpose: "selected-use", recipe: recipe(), frame: { width: 400, height: 200 }, signal: new AbortController().signal };
}
/** Header-only synthetic transport fixture. Deliberately not a valid decoded PNG;
 * full-container/native validation belongs to the authority-bound parent processor. */
function transportFixture(req: StudyImagePreviewRequest): StudyImagePreview {
  const bytes = new Uint8Array(33), d = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]); d.setUint32(8,13); bytes.set([73,72,68,82],12);
  d.setUint32(16,req.frame.width); d.setUint32(20,req.frame.height); bytes[24]=8;bytes[25]=2;
  return { useId: req.useId, documentId: req.documentId, sourceSha256: req.sourceSha256,
    width: req.frame.width, height: req.frame.height, recipeSha256: sha(canonicalOrthoMediaRecipe(req.recipe)),
    renditionSha256: sha(bytes), processorVersion: "synthetic-transport-only-v1", blob: new Blob([bytes],{type:"image/png"}) };
}
describe("study image edit recipe and preview transport",()=>{
  it("keeps two independent use identities and histories for the same original",()=>{
    const a=request(),b={...a,useId:"use2"};expect(studyImageScopeKey(a)).not.toBe(studyImageScopeKey(b));
    const first=startRecipeHistory(a.recipe),second=startRecipeHistory(b.recipe);
    const crop=cropFromCanvasPoints(a.recipe,{x:0,y:0},{x:200,y:200})!;
    const changed=pushRecipeHistory(first,first.current,crop)!;
    expect(changed.current).not.toBe(second.current);expect(second).toEqual(startRecipeHistory(b.recipe));
    expect(a.recipe.cropPpm).toEqual({left:0,top:0,right:1_000_000,bottom:1_000_000});
  });
  it("detaches and freezes every preview descriptor before an asynchronous parent call",()=>{
    const raw=request(),before=canonicalOrthoMediaRecipe(raw.recipe),captured=captureStudyImagePreviewRequest(raw);
    raw.recipe.cropPpm.left=250_000;raw.frame.width=200;
    expect(canonicalOrthoMediaRecipe(captured.recipe)).toBe(before);expect(captured.frame.width).toBe(400);
    for(const object of [captured,captured.frame,captured.recipe,captured.recipe.basis,captured.recipe.cropPpm])expect(Object.isFrozen(object)).toBe(true);
    expect(captured.signal).toBe(raw.signal);
  });
  it("captures returned Blob identity and metadata before digest awaits",async()=>{
    const req=captureStudyImagePreviewRequest(request()),raw=transportFixture(req),captured=captureStudyImagePreview(raw),blob=raw.blob;
    raw.blob=new Blob([new Uint8Array(33)],{type:"image/png"});raw.useId="different-use";raw.width=999;
    expect(Object.isFrozen(captured)).toBe(true);expect(captured.blob).toBe(blob);
    expect(await verifyStudyImagePreview(captured,req)).toBe(true);
    expect(await verifyStudyImagePreview(raw,req)).toBe(false);
  });
  it("maps displayed coordinates through actual containment and zoom box into the rotated canvas",()=>{
    const r=recipe(),box={left:10,top:20,width:800,height:800},frame={width:400,height:400};
    expect(pointOnCanvas(r,frame,box,{x:210,y:320})).toEqual({x:200,y:100});
    expect(pointOnCanvas(r,frame,box,{x:-10,y:-10})).toEqual({x:0,y:0});
    expect(pointOnCanvas(r,frame,{...box,width:0},{x:10,y:10})).toBeNull();
    expect(pointOnCanvas(r,frame,box,{x:Infinity,y:10})).toBeNull();
  });
  it("uses bounded reverse-drag/free/aspect crops with explicit subpixel refusal",()=>{
    const r=recipe();
    expect(cropFromCanvasPoints(r,{x:600,y:300},{x:200,y:100})!.cropPpm).toEqual({left:250_000,top:250_000,right:750_000,bottom:750_000});
    expect(cropFromCanvasPoints(r,{x:100,y:100},{x:500,y:300},1)!.cropPpm).toEqual({left:125_000,top:250_000,right:375_000,bottom:750_000});
    expect(cropFromCanvasPoints(r,{x:0,y:0},{x:.5,y:100})).toBeNull();
    expect(cropFromCanvasPoints(r,{x:0,y:0},{x:100,y:100},NaN)).toBeNull();
  });
  it("rotation reset is explicit; editor/original previews never alter the saved recipe",()=>{
    const r={...recipe(),rotationMilliDegrees:15_000,cropPpm:{left:100_000,top:100_000,right:900_000,bottom:900_000},fit:"cover" as const,brightnessPermille:1100};
    const before=canonicalOrthoMediaRecipe(r),rotated=rotateAndResetCrop(r,270_000);
    expect(rotated.rotationMilliDegrees).toBe(-90_000);expect(rotated.fit).toBe("contain");expect(rotated.cropPpm).toEqual(recipe().cropPpm);
    expect(canvasRecipe(r).brightnessPermille).toBe(1100);expect(originalComparisonRecipe(r)).toEqual(recipe());
    expect(canonicalOrthoMediaRecipe(r)).toBe(before);expect(editorCanvasFrame(recipe())).toEqual({width:800,height:400});
    expect(editorCanvasFrame(defaultOrthoMediaRecipe(2000,1000,1))).toEqual({width:900,height:450});
  });
  it("history refuses stale local CAS, supports bounded undo/redo and drops abandoned redo",()=>{
    let h=startRecipeHistory(recipe());const initial=h.current;
    for(let n=1;n<=50;n++)h=pushRecipeHistory(h,h.current,{...recipe(),brightnessPermille:1000+n})!;
    expect(h.before).toHaveLength(40);expect(pushRecipeHistory(h,initial,recipe())).toBeNull();
    const undo=stepRecipeHistory(h,"undo")!;expect(stepRecipeHistory(undo,"redo")).toEqual(h);
    const branched=pushRecipeHistory(undo,undo.current,{...recipe(),contrastPermille:1100})!;expect(branched.after).toEqual([]);
    expect(stepRecipeHistory(startRecipeHistory(recipe()),"undo")).toBeNull();
  });
  it("verifies exact use/source/recipe/frame/header/rendition transport without claiming native validity",async()=>{
    const req=captureStudyImagePreviewRequest(request()),preview=transportFixture(req);
    expect(await verifyStudyImagePreview(preview,req)).toBe(true);
    for(const changed of [{...preview,useId:"use2"},{...preview,documentId:2},{...preview,sourceSha256:"b".repeat(64)},
      {...preview,width:401},{...preview,recipeSha256:"b".repeat(64)},{...preview,renditionSha256:"b".repeat(64)},
      {...preview,processorVersion:"../../untrusted"},{...preview,blob:new Blob([new Uint8Array(33)],{type:"image/png"})},
      {...preview,blob:new Blob([new Uint8Array(4*1024*1024+1)],{type:"image/png"})}])expect(await verifyStudyImagePreview(changed,req)).toBe(false);
    const abort=new AbortController(),cancelled={...req,signal:abort.signal};abort.abort();expect(await verifyStudyImagePreview(preview,cancelled)).toBe(false);
  });
});
