import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),document:vi.fn(),read:vi.fn()}));
vi.mock("../lib/db",()=>({getDocumentForDownload:m.document,recordAudit:vi.fn(),removeDocument:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:m.session}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:m.access}));
vi.mock("../lib/files",()=>({readFileByKey:m.read}));
import { GET } from "../app/api/documents/[id]/route";
const bytes=Buffer.from("synthetic image bytes, not a patient file");
const sha=createHash("sha256").update(bytes).digest("hex");
const session={userId:1,username:"synthetic",role:"doctor"};
const document={id:51,patientId:11,title:"Synthetic image",mimeType:"image/png",removedAt:null as string|null};
const call=(query=`cephSource=${sha}`)=>GET(new Request(`http://localhost/api/documents/51${query?`?${query}`:""}`),{params:Promise.resolve({id:"51"})});
beforeEach(()=>{
  vi.clearAllMocks();m.session.mockResolvedValue(session);m.access.mockResolvedValue(true);
  m.document.mockResolvedValue({document:{...document},storageKey:"synthetic/image.png",sha256:sha});m.read.mockResolvedValue(bytes);
});
describe("ceph image response is bound to its viewed source identity",()=>{
  it("returns exactly the authorized bytes only when both metadata and actual bytes match",async()=>{
    const response=await call();expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(m.access).toHaveBeenCalledWith(session,11,"canViewXrays");
    expect(m.read).toHaveBeenCalledWith("synthetic/image.png");
  });
  it("rejects changed stored metadata before reading any file bytes",async()=>{
    m.document.mockResolvedValue({document,storageKey:"synthetic/image.png",sha256:"f".repeat(64)});
    expect((await call()).status).toBe(409);expect(m.read).not.toHaveBeenCalled();
  });
  it("fails closed when download metadata has no digest",async()=>{
    m.document.mockResolvedValue({document,storageKey:"synthetic/image.png"});
    expect((await call()).status).toBe(409);expect(m.read).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("synthetic swapped file"),Buffer.alloc(0)])("refuses corrupt or swapped response bytes %#",async wrong=>{
    m.read.mockResolvedValue(wrong);const response=await call();expect(response.status).toBe(409);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.text()).not.toContain("synthetic swapped file");
  });
  it.each(["", "bad", "A".repeat(64), "a".repeat(63), `${sha}&cephSource=${sha}`])("rejects malformed or repeated expected digest %#",async value=>{
    expect((await call(`cephSource=${value}`)).status).toBe(400);expect(m.read).not.toHaveBeenCalled();
  });
  it("retains missing-file handling without returning substituted content",async()=>{
    m.read.mockResolvedValue(null);expect((await call()).status).toBe(410);
  });
  it("keeps ordinary document downloads unchanged even with old or mismatched metadata",async()=>{
    m.document.mockResolvedValue({document,storageKey:"synthetic/image.png",sha256:"old-non-digest"});
    const response=await call("download=1");expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it("does not bypass session or patient authorization with a digest",async()=>{
    m.session.mockResolvedValue(null);expect((await call()).status).toBe(401);expect(m.document).not.toHaveBeenCalled();
    m.session.mockResolvedValue(session);m.access.mockResolvedValue(false);
    expect((await call("cephSource=bad")).status).toBe(403);expect(m.read).not.toHaveBeenCalled();
  });
  it("preserves hidden-document restrictions before serving matched bytes",async()=>{
    m.document.mockResolvedValue({document:{...document,removedAt:"2026-11-05"},storageKey:"synthetic/image.png",sha256:sha});
    expect((await call()).status).toBe(404);expect(m.read).not.toHaveBeenCalled();
  });
});
