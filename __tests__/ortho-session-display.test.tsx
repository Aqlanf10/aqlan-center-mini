import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import OrthoSessionDetails from '../components/OrthoSessionDetails';
import {sessionDetailFields,sessionExpectedFollowup,SESSION_FOLLOWUP_DISCLAIMER,type OrthoSessionDetail} from '../lib/ortho-session-display';
const entry:OrthoSessionDetail={id:51,doneOn:'2024-02-29',phase:'working',note:'Synthetic exact note\nلا تعديل < &',visitId:61,visitSigned:false,nextWeeks:4,recordedBy:'Synthetic author'};
describe('read-only recorded session detail',()=>{
 it('renders exact saved note, identifiers and historical phase without actions',()=>{const before=JSON.stringify(entry),html=renderToStaticMarkup(<OrthoSessionDetails entry={entry}/>);expect(html).toContain('Synthetic exact note\nلا تعديل &lt; &amp;');expect(html).toContain('51');expect(html).toContain('61');expect(html).toContain('2024-02-29');expect(html).toContain('غير موقّعة');expect(html).not.toMatch(/<button|<form|<img|<a /);expect(JSON.stringify(entry)).toBe(before);});
 it.each([true,false,null])('unlinked visit overrides signature value %s without inferring unsigned',visitSigned=>{const fields=sessionDetailFields({...entry,visitId:null,visitSigned});expect(fields.find(f=>f.label==='حالة توقيع الزيارة')?.value).toBe('لا توجد زيارة مرتبطة؛ حالة التوقيع غير معلومة');});
 it.each([[true,'موقّعة وفق'],[false,'غير موقّعة وفق'],[null,'غير معلومة']] as const)('distinguishes linked signature %s', (visitSigned,expected)=>{expect(sessionDetailFields({...entry,visitSigned}).find(f=>f.label==='حالة توقيع الزيارة')?.value).toContain(expected);});
 it('does not replace unknown historical phase or note with present case fields',()=>{const fields=sessionDetailFields({...entry,phase:null,note:null});expect(fields.find(f=>f.label==='المرحلة المسجلة لهذه الجلسة')?.value).toBe('غير مسجلة');expect(fields.find(f=>f.label==='ملاحظة الجلسة المسجلة')?.value).toBe('غير مسجلة');});
 it('retains an unrecognized stored phase rather than inventing a valid stage',()=>{expect(sessionDetailFields({...entry,phase:'historical_code'}).some(f=>f.value==='historical_code')).toBe(true);});
 it('calculates only the recorded interval and labels it neither booking nor attendance',()=>{expect(sessionExpectedFollowup('2024-02-29',4)).toBe('2024-03-28');expect(SESSION_FOLLOWUP_DISCLAIMER).toContain('ليس موعداً محجوزاً');});
 it.each([['2024-02-30',4],['bad',4],['2024-02-29',0],['2024-02-29',1.5],['2024-02-29',53]] as const)('refuses invalid date/interval %s %s rather than defaulting', (date,weeks)=>expect(sessionExpectedFollowup(date,weeks)).toBeNull());
});
