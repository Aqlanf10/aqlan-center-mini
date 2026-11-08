import {afterEach,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
import type {StudyDraftContent} from '../lib/ortho-case-study';
const hooks=vi.hoisted(()=>({cleanup:undefined as undefined|(()=>void)}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(value:unknown)=>[value,()=>undefined],useRef:(value:unknown)=>({current:value}),useEffect:(effect:()=>void|(()=>void))=>{hooks.cleanup=effect()||undefined;}}));
import Picker from '../components/OrthoStudyImagePicker';
const content={sources:[{key:'doc',kind:'document',id:61,version:null,contentHash:'a'.repeat(64)}],panels:[{instanceId:'face',layoutKey:'face-overview',sourceKeys:['doc'],images:[]}]} as unknown as StudyDraftContent;
function button(node:unknown):ReactElement<{onClick:()=>void}>|null{
 if(!node||typeof node!=='object')return null;
 const item=node as ReactElement<{children?:unknown,onClick:()=>void}>;
 if(item.type==='button')return item;
 for(const child of [item.props?.children].flat(Infinity)){const found=button(child);if(found)return found;}return null;
}
afterEach(()=>{hooks.cleanup?.();hooks.cleanup=undefined;vi.unstubAllGlobals();});
it.each([401,403])('informs the current parent of image basis HTTP %s',async status=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status})));
 const onDenied=vi.fn(),onAttach=vi.fn();
 const tree=Picker({scope:{patientId:19,orthoCaseId:41,clinicalCaseId:51},content,panelId:'face',editable:true,onDenied,onAttach});
 button(tree)!.props.onClick();await new Promise(resolve=>setTimeout(resolve,0));
 expect(onDenied).toHaveBeenCalledOnce();expect(onAttach).not.toHaveBeenCalled();
});
it('ignores a basis denial after the picker unmounts',async()=>{
 let finish!:(value:Response)=>void;vi.stubGlobal('fetch',vi.fn().mockReturnValue(new Promise<Response>(resolve=>{finish=resolve;})));
 const onDenied=vi.fn(),onAttach=vi.fn();
 const tree=Picker({scope:{patientId:19,orthoCaseId:41,clinicalCaseId:51},content,panelId:'face',editable:true,onDenied,onAttach});
 button(tree)!.props.onClick();hooks.cleanup?.();finish(new Response(null,{status:403}));await new Promise(resolve=>setTimeout(resolve,0));
 expect(onDenied).not.toHaveBeenCalled();expect(onAttach).not.toHaveBeenCalled();
});
