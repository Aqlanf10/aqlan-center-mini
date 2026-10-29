import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { LOGIN_PHOTO_ASSET as ASSET, LOGIN_PHOTO_VISIBLE as VISIBLE, LOGIN_PHOTO_BODY_BYTES,
  LOGIN_PHOTO_MAX_BYTES, loginPhotoVersions, parseLoginPhotoAsset } from "../lib/login-photo";
import { validateLoginPhotoBytes, storeLoginPhoto, readVerifiedLoginPhoto } from "../lib/login-photo-server";
import { GET as preview, POST as upload, PATCH as toggle } from "../app/api/settings/login-photo/route";
import { GET as publicPhoto } from "../app/api/branding/login-photo/route";
import { validateTypedSetting } from "../lib/settings-validate";
import { PUBLIC_SETTING_KEYS } from "../lib/settings";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), read: vi.fn(), save: vi.fn(), put: vi.fn(), file: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../lib/db", () => ({ readStoredSettings: mocks.read, saveSettingsAudited: mocks.save }));
vi.mock("../lib/files", () => ({ putFile: mocks.put, readFileByKey: mocks.file }));

// Synthetic 1x1 raster only; never reads or copies the owner's portrait.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==", "base64");
const asset = () => validateLoginPhotoBytes(PNG, "image/png")!;
let stored: Map<string, { value: string; updatedAt: string }>;
const versions = () => ({ [ASSET]: stored.get(ASSET)?.updatedAt ?? null, [VISIBLE]: stored.get(VISIBLE)?.updatedAt ?? null });
function configure(visible = false) {
  stored.set(ASSET, { value: JSON.stringify(asset()), updatedAt: "2026-10-28T00:00:00.000Z" });
  stored.set(VISIBLE, { value: String(visible), updatedAt: "2026-10-28T00:00:00.000Z" });
}
function uploadRequest(bytes = PNG, mime = "image/png", expected: unknown = versions(), extra: Record<string,string> = {}) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "synthetic.png", { type: mime }));
  form.set("__versions", JSON.stringify(expected));
  for (const [key,value] of Object.entries(extra)) form.set(key,value);
  return new Request("http://localhost/api/settings/login-photo", { method: "POST", body: form });
}
function toggleRequest(visible: unknown, expected: unknown = versions(), extra: Record<string,unknown> = {}) {
  return new Request("http://localhost/api/settings/login-photo", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visible, __versions: expected, ...extra }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  stored = new Map();
  mocks.session.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  mocks.read.mockImplementation(async () => new Map(stored));
  mocks.file.mockResolvedValue(PNG);
  mocks.put.mockImplementation(async (bytes: Buffer, extension: string) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { key: `${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}.${extension}`,
      sha256, sizeBytes: bytes.length, deduplicated: false };
  });
  mocks.save.mockImplementation(async (input: { values: Record<string,string>; expected: Record<string,string|null> }) => {
    for (const key of [ASSET,VISIBLE]) {
      if (input.expected[key] !== (stored.get(key)?.updatedAt ?? null)) return { ok:false, conflict:{key,currentUpdatedAt:stored.get(key)?.updatedAt ?? null} };
    }
    for (const [key,value] of Object.entries(input.values)) stored.set(key,{ value,updatedAt:"2026-10-28T01:00:00.000Z" });
    return { ok:true,changed:Object.keys(input.values),settings:Object.fromEntries([...stored].map(([k,v])=>[k,v.value])) };
  });
});

describe("login photo owned metadata and byte validation", () => {
  it("accepts only a bounded synthetic raster with a server-derived reserved key", () => {
    expect(asset()).toMatchObject({ mimeType:"image/png",width:1,height:1,sizeBytes:PNG.length });
    expect(asset().key).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.loginpng$/);
    expect(parseLoginPhotoAsset(JSON.stringify(asset()))).toEqual(asset());
  });
  it("accepts a complete synthetic JPEG without treating ordinary patient extensions as public", () => {
    const jpeg = validateLoginPhotoBytes(JPEG, "image/jpeg");
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", width: 1, height: 1, sizeBytes: JPEG.length });
    expect(jpeg?.key.endsWith(".loginjpg")).toBe(true);
  });
  it.each(["IHDR", "IDAT", "IEND"])("rejects a corrupt %s checksum before storage", kind => {
    const bytes = Buffer.from(PNG);
    let offset = 8;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === kind) {
        bytes[offset + 8 + length] ^= 1;
        break;
      }
      offset += length + 12;
    }
    expect(validateLoginPhotoBytes(bytes, "image/png")).toBeNull();
  });
  it("rejects the former PNG fixture whose IDAT checksum was invalid", () => {
    const invalid = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=", "base64");
    expect(validateLoginPhotoBytes(invalid, "image/png")).toBeNull();
  });
  it.each(["../../private.jpg", "/api/documents/1", "https://example.test/photo.png", "file:///etc/passwd"])("rejects foreign path %s", key => {
    expect(parseLoginPhotoAsset(JSON.stringify({...asset(),key}))).toBeNull();
  });
  it("rejects regular patient keys, mismatched hash directories and MIME extension substitution", () => {
    expect(parseLoginPhotoAsset(JSON.stringify({...asset(),key:asset().key.replace(".loginpng",".png")}))).toBeNull();
    expect(parseLoginPhotoAsset(JSON.stringify({...asset(),key:`ff/${asset().key.slice(3)}`}))).toBeNull();
    expect(parseLoginPhotoAsset(JSON.stringify({...asset(),mimeType:"image/jpeg"}))).toBeNull();
    expect(parseLoginPhotoAsset(JSON.stringify({...asset(),sha256:"a".repeat(64)}))).toBeNull();
  });
  it.each(["image/svg+xml","application/pdf","text/html","image/webp","image/jpeg"])("rejects PNG bytes falsely labeled %s", mime => {
    expect(validateLoginPhotoBytes(PNG,mime)).toBeNull();
  });
  it("rejects oversized, truncated, zero-dimension and excessive-pixel files", () => {
    expect(validateLoginPhotoBytes(Buffer.alloc(LOGIN_PHOTO_MAX_BYTES+1),"image/png")).toBeNull();
    expect(validateLoginPhotoBytes(PNG.subarray(0,PNG.length-1),"image/png")).toBeNull();
    expect(validateLoginPhotoBytes(Buffer.concat([PNG,Buffer.from("trailing")]),"image/png")).toBeNull();
    for (const [width,height] of [[0,1],[6001,1],[5000,5000]]) {
      const bytes = Buffer.from(PNG); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20);
      // Keep the chunk valid so the dimensional bound, not CRC, refuses it.
      bytes.writeUInt32BE(crc32(bytes.subarray(12,29)),29);
      expect(validateLoginPhotoBytes(bytes,"image/png")).toBeNull();
    }
  });
  it("rejects a JPEG header with dimensions and EOI but no image scan", () => {
    const headerOnly = Buffer.from("ffd8ffc0000b080001000101011100ffd9", "hex");
    expect(validateLoginPhotoBytes(headerOnly, "image/jpeg")).toBeNull();
  });
  it("rejects JPEG trailing payload even when followed by a second EOI", () => {
    const trailingPayload = Buffer.from("synthetic trailing payload", "ascii");
    expect(validateLoginPhotoBytes(Buffer.concat([JPEG, trailingPayload]), "image/jpeg")).toBeNull();
    expect(validateLoginPhotoBytes(Buffer.concat([JPEG, trailingPayload, Buffer.from([0xff, 0xd9])]), "image/jpeg")).toBeNull();
    expect(validateLoginPhotoBytes(Buffer.concat([JPEG, Buffer.from([0xff, 0xd9])]), "image/jpeg")).toBeNull();
  });
  it.each(["acTL","fcTL","fdAT"])("rejects PNG animation chunk %s", kind => {
    const chunk = Buffer.alloc(12); chunk.write(kind,4,"ascii");
    chunk.writeUInt32BE(crc32(chunk.subarray(4,8)),8);
    expect(validateLoginPhotoBytes(Buffer.concat([PNG.subarray(0,33),chunk,PNG.subarray(33)]),"image/png")).toBeNull();
  });
  it("requires both version stamps and rejects ambiguous version types", () => {
    for (const bad of [null,[],{}, {[ASSET]:null}, {[ASSET]:null,[VISIBLE]:3}]) expect(loginPhotoVersions(bad)).toBeNull();
    expect(loginPhotoVersions({[ASSET]:null,[VISIBLE]:null})).toEqual({[ASSET]:null,[VISIBLE]:null});
  });
  it("generic settings writes cannot bypass the dedicated owner route; asset keys are not public", () => {
    expect(validateTypedSetting(ASSET,JSON.stringify(asset()))).not.toBeNull();
    expect(validateTypedSetting(VISIBLE,"true")).not.toBeNull();
    expect(PUBLIC_SETTING_KEYS).not.toContain(ASSET);
  });
  it("verifies actual deduplicated bytes before metadata activation", async () => {
    mocks.file.mockResolvedValue(Buffer.from("not-the-image"));
    await expect(storeLoginPhoto(PNG,"image/png")).rejects.toThrow("LOGIN_PHOTO_STORAGE_INTEGRITY");
    expect(await readVerifiedLoginPhoto(asset())).toBeNull();
  });
});

describe("login photo permissions and bounded writes", () => {
  it.each([null,"doctor","reception","cashier","accountant","assistant"])("refuses preview/upload/toggle for role %s", async role => {
    mocks.session.mockResolvedValue(role ? { username:"synthetic",role } : null);
    const status = role ? 403 : 401;
    expect((await preview())!.status).toBe(status);
    expect((await upload(uploadRequest()))!.status).toBe(status);
    expect((await toggle(toggleRequest(true)))!.status).toBe(status);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([{}, {[ASSET]:null}, {[VISIBLE]:null}])("rejects incomplete versions before storage: %j", async bad => {
    expect((await upload(uploadRequest(PNG,"image/png",bad)))!.status).toBe(409);
    expect((await toggle(toggleRequest(false,bad)))!.status).toBe(409);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("limits the actual stream without requiring Content-Length", async () => {
    const request = new Request("http://localhost/api/settings/login-photo", {
      method:"POST",headers:{"Content-Type":"multipart/form-data; boundary=synthetic"},
      body:new Uint8Array(LOGIN_PHOTO_BODY_BYTES+1),
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await upload(request);
    expect(response!.status).toBe(413);
    expect(response!.headers.get("cache-control")).toContain("no-store");
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("rejects SVG before persistence and refuses visibility without a verified image", async () => {
    expect((await upload(uploadRequest(Buffer.from("<svg><script/></svg>"),"image/svg+xml")))!.status).toBe(400);
    expect((await toggle(toggleRequest(true)))!.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("upload always stays hidden and ignores client storage keys and visibility", async () => {
    configure(true);
    const expected = versions();
    const response = await upload(uploadRequest(PNG,"image/png",expected,{ key:"../../patient.jpg",visible:"true",[ASSET]:"forged" }));
    expect(response!.status).toBe(200);
    expect(mocks.put).toHaveBeenCalledWith(PNG,"loginpng");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      expected,transactionalAudit:true,actor:"synthetic-admin",actorRole:"admin",
      values:{ [ASSET]:JSON.stringify(asset()),[VISIBLE]:"false" },
    }));
    expect(stored.get(VISIBLE)?.value).toBe("false");
  });
  it("stale visibility cannot publish a replacement image", async () => {
    configure(false);
    const response = await toggle(toggleRequest(true,{[ASSET]:"stale",[VISIBLE]:versions()[VISIBLE]}));
    expect(response!.status).toBe(409);
    expect(stored.get(VISIBLE)?.value).toBe("false");
  });
  it("toggle locks both keys and never accepts client-supplied metadata", async () => {
    configure(false);
    const expected=versions();
    const response=await toggle(toggleRequest(true,expected,{ [ASSET]:"forged",key:"/api/documents/1",transactionalAudit:false }));
    expect(response!.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      expected,transactionalAudit:true,values:{[ASSET]:JSON.stringify(asset()),[VISIBLE]:"true"},
    }));
  });
  it("storage failure and atomic audit failure do not claim upload success or expose an image", async () => {
    mocks.put.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await upload(uploadRequest()))!.status).toBe(500);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new Error("audit transaction rolled back"));
    expect((await upload(uploadRequest()))!.status).toBe(500);
    expect(stored.size).toBe(0);
    expect((await publicPhoto()).status).toBe(404);
    // Transaction rollback itself is proven separately against the real DB/helper.
  });
});

describe("public login photo fails closed", () => {
  it("hidden image returns uncached 404 without reading bytes; admin preview can still show it", async () => {
    configure(false);
    const hidden=await publicPhoto();
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toContain("no-store");
    expect(hidden.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.file).not.toHaveBeenCalled();
    expect((await preview())!.status).toBe(200);
  });
  it("serves only the currently configured verified raster and rechecks visibility on every request", async () => {
    configure(true);
    const response=await publicPhoto();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    stored.set(VISIBLE,{value:"false",updatedAt:"later"});
    expect((await publicPhoto()).status).toBe(404);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("corrupt metadata, missing bytes, digest mismatch and DB failure never reveal another file", async () => {
    configure(true);
    stored.set(ASSET,{value:JSON.stringify({...asset(),key:asset().key.replace(".loginpng",".png")}),updatedAt:"now"});
    expect((await publicPhoto()).status).toBe(404);
    expect(mocks.file).not.toHaveBeenCalled();
    configure(true); mocks.file.mockResolvedValueOnce(null);
    expect((await publicPhoto()).status).toBe(404);
    mocks.file.mockResolvedValueOnce(Buffer.from("different"));
    expect((await publicPhoto()).status).toBe(404);
    mocks.read.mockRejectedValueOnce(new Error("DB unavailable"));
    expect((await publicPhoto()).status).toBe(404);
  });
});
