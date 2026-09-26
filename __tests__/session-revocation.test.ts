import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookie: vi.fn(), user: vi.fn(), header: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }), headers: async () => ({ get: mocks.header }) }));
vi.mock("../lib/db", () => ({ findUserByUsername: mocks.user }));
import { createSessionToken, sessionCredentialVersion } from "../lib/auth";
import { requireSession } from "../lib/session";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SESSION_SECRET = "isolated-test-secret-at-least-32-characters";
  mocks.user.mockResolvedValue({ id: 7, isActive: true, passwordHash: "old-hash", role: "doctor", partyId: 42 });
  mocks.cookie.mockReturnValue({ value: createSessionToken({ userId: 7, username: "test", role: "admin", partyId: 1,
    expiresAt: Date.now() + 60_000, credentialVersion: sessionCredentialVersion("old-hash") }) });
});

it("(P2-1) تغيير الدور يُنهي الجلسة — لا تبقى صلاحيات التوكن القديم ولا يُبدَّل دورٌ خلف الباب", async () => {
  // مديرٌ نُقل إلى «طبيب»: كان يُقرأ دوره الجديد بصمت؛ والآن يدخل من جديد، لأن
  // الباب (proxy) يحرس الكاشير والمحاسب بالدور الموقَّع في التوكن.
  expect(await requireSession()).toBeNull();
});
it("يقرأ الربط الحالي (party) بدل ربط التوكن القديم ما دام الدور نفسه", async () => {
  mocks.user.mockResolvedValue({ id: 7, isActive: true, passwordHash: "old-hash", role: "admin", partyId: 42 });
  expect(await requireSession()).toMatchObject({ role: "admin", partyId: 42 });
});
it("يرفض الحساب المعطل والتوكن السابق لتغيير كلمة المرور", async () => {
  mocks.user.mockResolvedValue(null);
  expect(await requireSession()).toBeNull();
  mocks.user.mockResolvedValue({ id: 7, isActive: true, passwordHash: "new-hash", role: "admin" });
  expect(await requireSession()).toBeNull();
});
it("يفشل مغلقًا عندما لا يمكن التحقق من المستخدم", async () => {
  mocks.user.mockRejectedValue(new Error("offline"));
  expect(await requireSession()).toBeNull();
});
it("يرفض الجلسات القديمة غير القابلة للإبطال", async () => {
  mocks.cookie.mockReturnValue({ value: createSessionToken({ userId: 7, username: "test", role: "admin", expiresAt: Date.now() + 60_000 }) });
  expect(await requireSession()).toBeNull();
});
