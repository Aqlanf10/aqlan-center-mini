import {afterEach,expect,it,vi} from 'vitest';
import {fetchStudyImageBasis,fetchStudyImagePreview,StudyImageAccessDenied} from '../lib/ortho-study-image-client';
import {defaultOrthoMediaRecipe} from '../lib/ortho-study-media';
const scope={patientId:19,orthoCaseId:41,clinicalCaseId:51,ownerKey:'synthetic'};
const request=()=>({ownerKey:'synthetic',documentId:61,sourceSha256:'a'.repeat(64),useId:'image1',purpose:'selected-use' as const,recipe:defaultOrthoMediaRecipe(12,8,1),frame:{width:12,height:8},signal:new AbortController().signal});
afterEach(()=>vi.unstubAllGlobals());
it.each([401,403])('signals basis and preview access revocation on HTTP %s',async status=>{
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(null,{status})));
 await expect(fetchStudyImageBasis(scope,61,'a'.repeat(64),new AbortController().signal)).rejects.toBeInstanceOf(StudyImageAccessDenied);
 expect(await fetchStudyImagePreview(scope,request())).toEqual({ok:false,code:'forbidden'});
});
it('never sends a request for a mismatched owner or aborted caller',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 expect(await fetchStudyImagePreview({...scope,ownerKey:'other'},request())).toEqual({ok:false,code:'stale'});
 const abort=new AbortController();abort.abort();
 expect(await fetchStudyImagePreview(scope,{...request(),signal:abort.signal})).toEqual({ok:false,code:'stale'});
 expect(fetch).not.toHaveBeenCalled();
});
it('rejects foreign decoded basis and missing private no-store transport',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,patientId:20}),{headers:{'cache-control':'private, no-store'}})));
 await expect(fetchStudyImageBasis(scope,61,'a'.repeat(64),new AbortController().signal)).rejects.toThrow('identity');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{headers:{'content-type':'image/png'}})));
 expect(await fetchStudyImagePreview(scope,request())).toEqual({ok:false,code:'stale'});
});
