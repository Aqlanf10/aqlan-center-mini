import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, expect, it, vi } from 'vitest';
import { facialImageBasis } from '../lib/ortho-facial-image';
const storage=vi.hoisted(()=>({bytes:Buffer.alloc(0)}));
vi.mock('../lib/files',()=>({readFileByKey:async()=>storage.bytes,readFileByKeyBounded:async(_key:string,max:number)=>{if(storage.bytes.length>max)throw Error('limit');return storage.bytes;}}));
vi.mock('../lib/ortho-case-journey-authority',()=>({journeyFail:(_status:number,code:string)=>{throw Error(code);}}));
const source=()=>({sha256:createHash('sha256').update(storage.bytes).digest('hex'),storage_key:'synthetic.png',size_bytes:String(storage.bytes.length),mime_type:'image/png'});
beforeEach(async()=>{storage.bytes=await sharp({create:{width:100,height:100,channels:3,background:'#689abc'}}).png().toBuffer();});
it('fully decodes source bytes even when only requesting the measurement basis',async()=>{
 storage.bytes=storage.bytes.subarray(0,storage.bytes.length-30);
 await expect(facialImageBasis(source())).rejects.toThrow();
});
it('rejects encoded MIME mismatches rather than trusting stored MIME',async()=>{await expect(facialImageBasis({...source(),mime_type:'image/jpeg'})).rejects.toThrow();});
it('rejects invalid size before reading storage',async()=>{await expect(facialImageBasis({...source(),size_bytes:'-1'})).rejects.toThrow();});
it('preserves synthetic pixels and original bytes through oriented preview',async()=>{
 const bytes=Buffer.from(storage.bytes),result=await facialImageBasis(source(),true);
 expect(result.basis).toMatchObject({width:100,height:100,exifOrientation:1});
 expect((await sharp(result.png!).metadata()).width).toBe(100);expect(storage.bytes).toEqual(bytes);
});
it.each([
 [1,[0,1,2,3,4,5],3,2],[2,[2,1,0,5,4,3],3,2],
 [3,[5,4,3,2,1,0],3,2],[4,[3,4,5,0,1,2],3,2],
 [5,[0,3,1,4,2,5],2,3],[6,[3,0,4,1,5,2],2,3],
 [7,[5,2,4,1,3,0],2,3],[8,[2,5,1,4,0,3],2,3],
])('applies EXIF orientation %s exactly once with asymmetric pixels',async(orientation,order,width,height)=>{
 const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255]];
 storage.bytes=await sharp(Buffer.from(colors.flat()),{raw:{width:3,height:2,channels:3}}).withMetadata({orientation:orientation as number}).png().toBuffer();
 const original=Buffer.from(storage.bytes),result=await facialImageBasis(source(),true);
 expect(result.basis).toMatchObject({width,height,exifOrientation:orientation});
 const pixels=await sharp(result.png!).removeAlpha().raw().toBuffer();
 expect([...pixels]).toEqual((order as number[]).flatMap(i=>colors[i]));
 expect(storage.bytes).toEqual(original);
});
