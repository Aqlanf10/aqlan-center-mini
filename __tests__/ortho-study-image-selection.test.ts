import { expect, it } from 'vitest';
import { CASE_TEMPLATE_VERSION } from '../lib/ortho-case-template';
import { attachStudyImage, detachStudyImage } from '../lib/ortho-study-image-selection';
import { defaultOrthoMediaRecipe } from '../lib/ortho-study-media';
import { readStudyImageCommand } from '../lib/ortho-study-image-contract';
import type { StudyDraftContent } from '../lib/ortho-case-study';
const source = {key:'document_1',kind:'document' as const,id:1,version:null,contentHash:'a'.repeat(64)};
const content = (): StudyDraftContent => ({template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:'b'.repeat(64)},identityDisclosure:'case_only',sources:[source],groups:[],mediaUses:[],comment:'',panels:[{instanceId:'panel1',layoutKey:'face-overview',included:true,state:'available',sourceKeys:[source.key],images:[],comment:''}]});
const recipe = defaultOrthoMediaRecipe(20,30,1);
it('assigns a verified source without guessing clinical view/date and persists through JSON roundtrip', () => {
  const before = content(), after = attachStudyImage(before,source,'panel1','face-front',recipe,'use1');
  expect(before.mediaUses).toEqual([]); expect(after.mediaUses[0]).toMatchObject({sourceSha256:source.contentHash,view:'unassigned',groupId:null,recipe});
  expect(JSON.parse(JSON.stringify(after))).toEqual(after);
  const twice = attachStudyImage(after,source,'panel1','face-smile',recipe,'use2');
  expect(twice.mediaUses.map(u => u.order)).toEqual([0,1]);
  expect(detachStudyImage(twice,'use1').mediaUses.map(u => u.useId)).toEqual(['use2']);
  expect(detachStudyImage(twice,'use1').sources).toEqual([source]);
});
it('refuses occupied slots, stale sources, unknown basis and inherited edits on replacement', () => {
  const saved = attachStudyImage(content(),source,'panel1','face-front',recipe,'use1');
  expect(() => attachStudyImage(saved,source,'panel1','face-front',recipe,'use2')).toThrow();
  expect(() => attachStudyImage(content(),{...source,contentHash:'c'.repeat(64)},'panel1','face-front',recipe,'use1')).toThrow();
  for (const invalid of [{...recipe,basis:{...recipe.basis,exifOrientation:null}},{...recipe,rotationMilliDegrees:90000}]) expect(() => attachStudyImage(content(),source,'panel1','face-front',invalid,'use1')).toThrow();
  expect(() => attachStudyImage(content(),source,'other','face-front',recipe,'use1')).toThrow();
});
it('admits bounded exact commands and refuses authority fields, huge images or altered original comparisons', () => {
  const command = {patientId:1,documentId:1,sha256:source.contentHash,useId:'use1',purpose:'selected-use',recipe,frame:{width:20,height:30}};
  expect(readStudyImageCommand(command)).toEqual(command);
  for (const invalid of [{...command,patientId:'1'},{...command,storageKey:'private'},{...command,frame:{width:4000,height:4000}},{...command,purpose:'original-comparison',recipe:{...recipe,brightnessPermille:1100}},{...command,purpose:'editor-canvas',recipe:{...recipe,fit:'cover'}}]) expect(readStudyImageCommand(invalid)).toBeNull();
});
