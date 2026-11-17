import { expect, it } from 'vitest';
import { classifyPatientReplayRefusal } from './helpers/synthetic-patient-replay-refusal';

const busy='فشل تطبيق بيانات الاستعادة على الهدف المعزول: patient numbering busy; refresh and retry';
const nonempty='الهدف ليس فارغًا (12 جدولًا). الاستعادة فوق بيانات قائمة مرفوضة افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل.';
const rejection=(error:string)=>({ok:false,readyForCutover:false,validationErrors:[] as string[],errors:[error]});

it('recognizes only the bounded known patient replay refusals',()=>{
  expect(classifyPatientReplayRefusal(rejection(busy))).toBe('BUSY');
  expect(classifyPatientReplayRefusal(rejection(nonempty))).toBe('NONEMPTY');
  expect(classifyPatientReplayRefusal(rejection(busy+' SYNTHETIC-EXTRA'))).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal({...rejection(busy),errors:[busy,'SYNTHETIC-EXTRA']})).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal(rejection('RESTORE_REPLAY_FAILED (SQLSTATE 55P03)'))).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal(rejection(nonempty.replace('(12 ','(0 ')))).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal({...rejection(busy),validationErrors:['SYNTHETIC-INVALID']})).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal({...rejection(busy),ok:true})).toBe('UNKNOWN');
  expect(classifyPatientReplayRefusal({...rejection(busy),readyForCutover:true})).toBe('UNKNOWN');
});
