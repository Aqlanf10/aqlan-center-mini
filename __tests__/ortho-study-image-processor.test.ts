import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it } from "vitest";
import { defaultOrthoMediaRecipe, canonicalOrthoMediaRecipe } from "../lib/ortho-study-media";
import { inspectStudyImage, renderStudyImage, withStudyImageSlot } from "../lib/ortho-study-image-processor";
const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
const original = () => sharp(Buffer.from(colors.flat()), { raw: { width: 2, height: 3, channels: 3 } }).png().toBuffer();
const pixels = async (png: Buffer) => { const raw = await sharp(png).removeAlpha().raw().toBuffer(); return Array.from({ length: raw.length / 3 }, (_, n) => Array.from(raw.subarray(n * 3, n * 3 + 3))); };
it("renders the original without altering source bytes, and binds recipe/bytes to the witness", async () => {
  const bytes = await original(), before = Buffer.from(bytes), recipe = defaultOrthoMediaRecipe(2, 3, 1);
  const result = await renderStudyImage(bytes, recipe, { width: 2, height: 3 });
  expect(await pixels(result.png)).toEqual(colors); expect(bytes).toEqual(before);
  expect(result.recipeSha256).toBe(createHash('sha256').update(canonicalOrthoMediaRecipe(recipe)).digest('hex'));
  expect(result.renditionSha256).toBe(createHash('sha256').update(result.png).digest('hex'));
  const meta = await sharp(result.png).metadata(); expect(meta.exif).toBeUndefined(); expect(meta.orientation).toBeUndefined(); expect(meta.channels).toBe(3);
});
it.each([
  [1, [0, 1, 2, 3, 4, 5]], [2, [1, 0, 3, 2, 5, 4]], [3, [5, 4, 3, 2, 1, 0]], [4, [4, 5, 2, 3, 0, 1]],
  [5, [0, 2, 4, 1, 3, 5]], [6, [4, 2, 0, 5, 3, 1]], [7, [5, 3, 1, 4, 2, 0]], [8, [1, 3, 5, 0, 2, 4]],
] as const)("applies EXIF orientation %i exactly once before display transformations", async (orientation, order) => {
  const bytes = await sharp(await original()).withMetadata({ orientation }).png().toBuffer();
  const basis = await inspectStudyImage(bytes), width = orientation >= 5 ? 3 : 2, height = orientation >= 5 ? 2 : 3;
  expect(basis).toMatchObject({ orientedWidth: width, orientedHeight: height, exifOrientation: orientation });
  const result = await renderStudyImage(bytes, defaultOrthoMediaRecipe(width, height, orientation), { width, height });
  expect(await pixels(result.png)).toEqual(order.map(i => colors[i]));
});
it("rotates clockwise, then crops the selected expanded canvas; contain letterboxes white", async () => {
  const bytes = await original();
  const rotated = { ...defaultOrthoMediaRecipe(2, 3, 1), rotationMilliDegrees: 90000 };
  expect(await pixels((await renderStudyImage(bytes, rotated, { width: 3, height: 2 })).png)).toEqual([4, 2, 0, 5, 3, 1].map(i => colors[i]));
  const crop = { ...rotated, cropPpm: { left: 333334, top: 0, right: 666666, bottom: 1000000 } };
  expect(await pixels((await renderStudyImage(bytes, crop, { width: 1, height: 2 })).png)).toEqual([colors[2], colors[3]]);
  const contained = await renderStudyImage(bytes, defaultOrthoMediaRecipe(2, 3, 1), { width: 4, height: 3 });
  expect(await pixels(contained.png)).toEqual([[255,255,255],colors[0],colors[1],[255,255,255],[255,255,255],colors[2],colors[3],[255,255,255],[255,255,255],colors[4],colors[5],[255,255,255]]);
});
it("uses channel lookup before white alpha compositing", async () => {
  const bytes = await sharp(Buffer.from([100, 150, 200, 128]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const recipe = { ...defaultOrthoMediaRecipe(1, 1, 1), brightnessPermille: 1200, contrastPermille: 800 };
  // LUT gives [122,170,218]; alpha128 over white yields [188,212,236].
  expect(await pixels((await renderStudyImage(bytes, recipe, { width: 1, height: 1 })).png)).toEqual([[188, 212, 236]]);
});
it("refuses an unverified orientation, swapped basis, external SVG and excessive output before rendering", async () => {
  const bytes = await original();
  await expect(renderStudyImage(bytes, defaultOrthoMediaRecipe(2,3,null), {width:2,height:3})).rejects.toMatchObject({code:'orientation_required'});
  await expect(renderStudyImage(bytes, defaultOrthoMediaRecipe(3,2,1), {width:3,height:2})).rejects.toMatchObject({code:'source_basis_mismatch'});
  await expect(inspectStudyImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'))).rejects.toMatchObject({code:'unavailable'});
  await expect(renderStudyImage(bytes, defaultOrthoMediaRecipe(2,3,1), {width:2001,height:2000})).rejects.toMatchObject({code:'size_limit'});
});
it("admits one processor at a time and releases its slot after a refusal", async () => {
  let release!: () => void; const pending = withStudyImageSlot(() => new Promise<void>(resolve => {release=resolve;}));
  await expect(withStudyImageSlot(async () => 1)).rejects.toMatchObject({code:'processor_busy'});
  release(); await pending;
  await expect(withStudyImageSlot(async () => { throw Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
  expect(await withStudyImageSlot(async () => 2)).toBe(2);
});
it.each(['jpeg','webp'] as const)('decodes %s with its actual EXIF basis and strips private metadata in the rendition',async format=>{
  const bytes=await sharp({create:{width:20,height:30,channels:3,background:'#335577'}}).withMetadata({orientation:6}).toFormat(format).toBuffer();
  expect(await inspectStudyImage(bytes)).toMatchObject({format,orientedWidth:30,orientedHeight:20,exifOrientation:6});
  const result=await renderStudyImage(bytes,defaultOrthoMediaRecipe(30,20,6),{width:30,height:20});
  const metadata=await sharp(result.png).metadata();expect(metadata).toMatchObject({format:'png',width:30,height:20,channels:3});expect(metadata.exif).toBeUndefined();
});
it('cover uses the central crop without stretching, and arbitrary rotation is bounded with white background',async()=>{
  const data=Buffer.from([[255,0,0],[0,255,0],[0,0,255],[255,255,0]].flat());
  const bytes=await sharp(data,{raw:{width:4,height:1,channels:3}}).png().toBuffer();
  expect(await pixels((await renderStudyImage(bytes,{...defaultOrthoMediaRecipe(4,1,1),fit:'cover'},{width:2,height:1})).png)).toEqual([[0,255,0],[0,0,255]]);
  const rotated=await renderStudyImage(bytes,{...defaultOrthoMediaRecipe(4,1,1),rotationMilliDegrees:45000},{width:5,height:5});
  // The top-left pixel intersects the antialiased red edge. Bottom-left is outside the rotated strip.
  expect((await pixels(rotated.png))[20]).toEqual([255,255,255]);expect((await sharp(rotated.png).metadata()).width).toBe(5);
});
