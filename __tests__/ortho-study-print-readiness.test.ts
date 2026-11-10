import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fullStudyPrintFits } from '../lib/ortho-study-print-readiness';
const rect=(left=0,top=0,width=960,height=718)=>({left,top,width,height,right:left+width,bottom:top+height});
function fixture(){
 const frame=rect();
 const regions=Array.from({length:4},(_,index)=>{const box=rect(0,index*175,960,170);const child={getBoundingClientRect:()=>({...box}),scrollWidth:960,clientWidth:960,scrollHeight:170,clientHeight:170};return {getBoundingClientRect:()=>({...box}),scrollWidth:960,clientWidth:960,scrollHeight:170,clientHeight:170,querySelectorAll:()=>[child],child};});
 const sheet={getBoundingClientRect:()=>({...frame}),scrollWidth:960,clientWidth:960,scrollHeight:718,clientHeight:718,querySelectorAll:()=>regions};
 const images=[{complete:true,naturalWidth:200,naturalHeight:100}];
 const root={querySelectorAll:(selector:string)=>selector.includes('img')?images:[sheet]};
 return {root:root as unknown as HTMLElement,sheet,regions,images};
}
beforeEach(()=>vi.stubGlobal('document',{fonts:{status:'loaded',forEach:()=>{}}}));afterEach(()=>vi.unstubAllGlobals());
it('admits only loaded images/fonts and all measured header/body/footer regions within sheets',()=>{expect(fullStudyPrintFits(fixture().root)).toBe(true);});
it.each(['header','body','footer'] as const)('refuses %s overflow without clipping or hiding missing facts',region=>{const f=fixture();f.regions[region==='header'?0:region==='body'?2:3].scrollHeight=180;expect(fullStudyPrintFits(f.root)).toBe(false);});
it('refuses child overflow even if the containing region itself has a fixed rectangle',()=>{const f=fixture();f.regions[2].child.getBoundingClientRect=()=>rect(0,350,960,180);expect(fullStudyPrintFits(f.root)).toBe(false);});
it('refuses unready fonts, failed image, zero-size frame and absent page regions',()=>{
 const f=fixture();vi.stubGlobal('document',{fonts:{status:'loading',forEach:()=>{}}});expect(fullStudyPrintFits(f.root)).toBe(false);
 vi.stubGlobal('document',{fonts:{status:'loaded',forEach:()=>{}}});f.images[0].naturalWidth=0;expect(fullStudyPrintFits(f.root)).toBe(false);
 f.images[0].naturalWidth=200;f.sheet.getBoundingClientRect=()=>rect(0,0,0,0);expect(fullStudyPrintFits(f.root)).toBe(false);
});

it('refuses a failed declared font used by the printout even after FontFaceSet reports loaded',()=>{
 const f=fixture();vi.stubGlobal('getComputedStyle',()=>({fontFamily:'SyntheticMissing, Arial'}));
 vi.stubGlobal('document',{fonts:{status:'loaded',forEach:(visit:(font:{family:string;status:string})=>void)=>visit({family:'SyntheticMissing',status:'error'})}});
 expect(fullStudyPrintFits(f.root)).toBe(false);
 vi.stubGlobal('getComputedStyle',()=>({fontFamily:'Arial'}));expect(fullStudyPrintFits(f.root)).toBe(true);
});
