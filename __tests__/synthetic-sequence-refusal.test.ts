import { expect, it } from 'vitest';
import { knownLateDuplicate, knownNonEmptyRefusal } from './helpers/synthetic-sequence-refusal';

const known='الهدف ليس فارغًا (12 جدولًا). الاستعادة فوق بيانات قائمة مرفوضة افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل.';
const rejection=()=>({ok:false,readyForCutover:false,validationErrors:[] as string[],errors:[known]});

it('recognizes only the exact existing nonempty target result',()=>{
  expect(knownNonEmptyRefusal(rejection())).toBe(true);
  expect(knownNonEmptyRefusal({...rejection(),errors:[known+' SYNTHETIC-EXTRA']})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),errors:[known,'SYNTHETIC-EXTRA']})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),errors:['SYNTHETIC-UNKNOWN']})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),errors:[known.replace('(12 ', '(0 ')]})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),validationErrors:['SYNTHETIC-INVALID']})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),ok:true})).toBe(false);
  expect(knownNonEmptyRefusal({...rejection(),readyForCutover:true})).toBe(false);
});

it('recognizes only the exact synthetic late duplicate failure',()=>{
  const duplicate='فشل تطبيق بيانات الاستعادة على الهدف المعزول: duplicate key value violates unique constraint "patients_pkey"';
  const result={ok:false,readyForCutover:false,validationErrors:[] as string[],errors:[duplicate]};
  expect(knownLateDuplicate(result)).toBe(true);
  expect(knownLateDuplicate({...result,errors:[duplicate+' SYNTHETIC-EXTRA']})).toBe(false);
  expect(knownLateDuplicate({...result,errors:[duplicate,'SYNTHETIC-EXTRA']})).toBe(false);
  expect(knownLateDuplicate({...result,errors:['patients_pkey']})).toBe(false);
  expect(knownLateDuplicate({...result,validationErrors:['SYNTHETIC-INVALID']})).toBe(false);
  expect(knownLateDuplicate({...result,ok:true})).toBe(false);
  expect(knownLateDuplicate({...result,readyForCutover:true})).toBe(false);
});
