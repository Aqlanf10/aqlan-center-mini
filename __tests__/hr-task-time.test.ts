import {it,expect} from 'vitest';
import {parseTaskDeadline,taskDeadlineInput} from '../lib/hr-task-time';
it('uses the clinic zone for a local deadline and round trips without depending on the process zone',()=>{
 const iso=parseTaskDeadline('2026-10-12T14:00','Asia/Aden');
 expect(iso).toBe('2026-10-12T11:00:00.000Z');
 expect(taskDeadlineInput(iso,'Asia/Aden')).toBe('2026-10-12T14:00');
 expect(parseTaskDeadline('2026-10-12T14:00:00+03:00','Asia/Aden')).toBe(iso);
});
it('rejects invalid calendar dates and absent timezone conventions',()=>{
 for(const value of ['2026-02-30T14:00','2026-02-30T14:00:00Z','2026-10-12','2026-10-12T25:00',false]) expect(()=>parseTaskDeadline(value,'Asia/Aden')).toThrow();
});
