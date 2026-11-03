import {expect,it,vi} from 'vitest';
import {openSavedPrescriptionPrint} from '../lib/prescription-print-opening';
it('retains an exact saved-record link when popup is blocked without issuing anything',()=>{const open=vi.fn(()=>null);expect(openSavedPrescriptionPrint(12,34,open)).toEqual({url:'/print/prescription/12?rx=34',opened:false});expect(open).toHaveBeenCalledExactlyOnceWith('/print/prescription/12?rx=34','_blank');});
it('detects browser exceptions and successful opening',()=>{expect(openSavedPrescriptionPrint(12,34,()=>{throw Error('blocked');})?.opened).toBe(false);expect(openSavedPrescriptionPrint(12,34,()=>({closed:false}))?.opened).toBe(true);});
it('cannot create a fallback for invalid or unverified record identifiers',()=>{for(const pair of [[0,2],[1,-2],[NaN,2],[1,Infinity],[1,2.2]]){const open=vi.fn();expect(openSavedPrescriptionPrint(pair[0],pair[1],open)).toBeNull();expect(open).not.toHaveBeenCalled();}});
