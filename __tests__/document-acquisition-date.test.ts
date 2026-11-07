import {expect,it} from 'vitest';
import {isDocumentAcquisitionDate} from '../lib/document-acquisition-date';
it.each(['0001-01-01','0096-02-29','1600-02-29','2000-02-29','2024-02-29','9999-12-31'])('admits date%s without current time or early-year normalization',value=>expect(isDocumentAcquisitionDate(value)).toBe(true));
it.each(['0000-01-01','0100-02-29','1700-02-29','1900-02-29','2100-02-29','2026-11-31','10000-01-01','٢٠٢٦-٠١-٠١',null,undefined,1,{},''])('refuses noncalendar/noncanonical value%s',value=>expect(isDocumentAcquisitionDate(value)).toBe(false));
it('does not inspect the current clock',()=>{const date=globalThis.Date;try{globalThis.Date=class {constructor(){throw Error('clock forbidden');}static now(){throw Error('clock forbidden');}} as unknown as DateConstructor;expect(isDocumentAcquisitionDate('2024-02-29')).toBe(true);expect(isDocumentAcquisitionDate('2023-02-29')).toBe(false);}finally{globalThis.Date=date;}});
