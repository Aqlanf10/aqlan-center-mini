import { expect, it } from 'vitest';
import { knownNonEmptyRefusal } from './helpers/synthetic-sequence-refusal';

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
