import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { INTAKE_CONDITIONS as shared } from '../lib/portal-intake-fields';
import { INTAKE_CONDITIONS as legacy, validateIntake } from '../lib/portal';
it('preserves the existing intake vocabulary and server validation export',()=>{
 expect(shared).toBe(legacy);expect(shared.map(c=>c.key)).toEqual(['diabetes','hypertension','heart','asthma','kidney','liver','thyroid','epilepsy','pregnancy','bleeding','anesthesia']);
 expect(validateIntake({conditions:['diabetes']})).toMatchObject({ok:true,value:{conditions:['diabetes']}});
});
it('bundles public intake fields for the browser without signing or node builtins',async()=>{
 const result=await build({stdin:{contents:'import { INTAKE_CONDITIONS } from "./lib/portal-intake-fields"; export default INTAKE_CONDITIONS;',resolveDir:process.cwd()},bundle:true,platform:'browser',write:false,format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs)).toEqual(['lib/portal-intake-fields.ts','<stdin>']);
 expect(result.outputFiles[0].text).not.toMatch(/SESSION_SECRET|createHmac|timingSafeEqual|node:crypto/);
});
it.each(['app/portal/page.tsx','components/patient/PatientIntakeHistory.tsx'])('keeps %s on the public field module',async path=>{
 const source=await readFile(path,'utf8');expect(source).toContain('from "@/lib/portal-intake-fields"');expect(source).not.toContain('from "@/lib/portal"');
});
