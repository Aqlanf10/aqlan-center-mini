import {expect,it} from 'vitest';
import {compareSavedDiagnoses,type DiagnosisComparisonEntry} from '../lib/ortho-diagnosis-comparison';
const entry=(id:number,content:Record<string,string|null>,version=id):DiagnosisComparisonEntry=>({id,version,orthoCaseId:9,content,label:null,createdBy:`Synthetic ${id}`,createdAt:'2026-11-06T00:00:00.000Z'});
const selected={orthoCaseId:9,leftId:2,rightId:8};
it('preserves partial entries without carryforward and treats patient-wide version gaps as ordinary metadata',()=>{
 const rows=[entry(8,{dental:'II',note:''},17),entry(2,{skeletal:'II',note:null},4)],r=compareSavedDiagnoses(rows,selected);
 expect(r).toMatchObject({ok:true,left:rows[1],right:rows[0],fields:[{key:'dental',left:{state:'absent'},right:{state:'text',value:'II'},comparison:'different'},{key:'note',left:{state:'null'},right:{state:'empty'},comparison:'different'},{key:'skeletal',left:{state:'text',value:'II'},right:{state:'absent'},comparison:'different'}]});
});
it.each([[null,null,'same'],['','','same'],[' II ','II','different'],['0','0','same'],['7mm','5mm','different'],['\n',' ','different']] as const)('compares literal%s to%s as%s', (left,right,comparison)=>{const r=compareSavedDiagnoses([entry(2,{note:left}),entry(8,{note:right})],selected);expect(r.ok&&r.fields[0].comparison).toBe(comparison);});
it('keeps unknown and prototype-like own keys, escaping is the renderer responsibility',()=>{
 const content=JSON.parse('{"__proto__":"literal","constructor":null,"toString":"<script>synthetic</script>"}');const r=compareSavedDiagnoses([entry(2,content),entry(8,{})],selected);
 expect(r.ok).toBe(true);if(!r.ok)throw Error('fixture');expect(r.fields.map(x=>x.key)).toEqual(['__proto__','constructor','toString']);expect(r.fields[0].left).toEqual({state:'text',value:'literal'});expect(Object.hasOwn(r.left.content,'__proto__')).toBe(true);expect(r.left.content.__proto__).toBe('literal');
});
it('preserves explicit reversed selection order and never chooses latest as fallback',()=>{const rows=[entry(8,{note:'new'},17),entry(2,{note:'old'},4)];expect(compareSavedDiagnoses(rows,{...selected,leftId:8,rightId:2})).toMatchObject({ok:true,left:rows[0],right:rows[1]});expect(compareSavedDiagnoses(rows,{...selected,rightId:99})).toEqual({ok:false,code:'invalid_diagnosis_comparison'});});
it('rejects same selection, conflicting scope, duplicate IDs and invalid entry structure',()=>{
 const rows=[entry(2,{note:null}),entry(8,{note:''})];
 for(const ids of [{leftId:2,rightId:2},{leftId:NaN,rightId:8},{leftId:2,rightId:8,orthoCaseId:10}])expect(compareSavedDiagnoses(rows,{...selected,...ids}).ok).toBe(false);
 for(const bad of [[...rows,rows[0]],[rows[0],{...rows[1],orthoCaseId:10}],[rows[0],{...rows[1],createdAt:'invalid'}],[rows[0],{...rows[1],content:{note:3}}],[rows[0],{...rows[1],version:0}]])expect(compareSavedDiagnoses(bad as DiagnosisComparisonEntry[],selected).ok).toBe(false);
});
it('returns detached metadata/content without mutating source',()=>{const rows=[entry(2,{note:'old'}),entry(8,{note:'new'})],before=structuredClone(rows),r=compareSavedDiagnoses(rows,selected);expect(rows).toEqual(before);if(!r.ok)throw Error('fixture');r.left.content.note='mutated';r.left.createdBy='changed';expect(rows).toEqual(before);});
it('valid empty content yields empty comparison, not malformed or fabricated diagnosis',()=>{expect(compareSavedDiagnoses([entry(2,{}),entry(8,{})],selected)).toMatchObject({ok:true,fields:[]});});
it('rejects inherited/accessor/symbol content instead of evaluating it or dropping it',()=>{
 const contents=[Object.create({note:'inherited'}),Object.defineProperty({},'note',{enumerable:true,get(){throw Error('must not evaluate');}}),{[Symbol('hidden')]:'value'}];
 for(const content of contents)expect(compareSavedDiagnoses([entry(2,content),entry(8,{})],selected)).toEqual({ok:false,code:'invalid_diagnosis_comparison'});
});
it('preserves raw metadata strings and literal whitespace values',()=>{const left={...entry(2,{note:' \n '}),label:' label ',createdBy:' Author ',createdAt:'2026-01-01T01:00:00+01:00'},r=compareSavedDiagnoses([left,entry(8,{note:' \n '})],selected);expect(r).toMatchObject({ok:true,left,fields:[{key:'note',left:{state:'text',value:' \n '},comparison:'same'}]});});
it('bundles for browsers without server or clinical calculation dependencies',async()=>{const {build}=await import('esbuild');const bundle=await build({entryPoints:['lib/ortho-diagnosis-comparison.ts'],platform:'browser',bundle:true,write:false,metafile:true,logLevel:'silent'});expect(Object.keys(bundle.metafile!.inputs)).toEqual(['lib/ortho-diagnosis-comparison.ts']);});
