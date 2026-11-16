import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const transport = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  authorization: undefined as string | undefined,
  user: {} as Record<string, unknown>,
  buildReport: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => transport.cookie === undefined ? undefined : { value: transport.cookie } }),
  headers: async () => ({ get: (key: string) => key === "authorization" ? transport.authorization : null }),
}));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: transport.findUser }));
vi.mock("../lib/reports", () => ({
  ReportInputError: class extends Error {},
  buildReport: transport.buildReport,
  dbTodayISO: async () => "2026-11-01", parseFilters: () => ({}), reportOptions: () => ({}), validateAnnualReportRange: () => {},
}));

import { createSessionToken, readSessionToken, readSignedSessionEnvelope, SESSION_COOKIE, sessionCredentialVersion, sessionPermissionVersion } from "../lib/auth";
import { financeAccessFor } from "../lib/finance-permissions";
import { verifiedSessionAccess, verifiedSessionRole } from "../lib/proxy-role";
import { readSessionPayload, requireSession } from "../lib/session";
import { proxy } from "../proxy";
import { GET as report } from "../app/api/reports/route";

const NOW = 1_800_000_000_000;
const SECRET = "session-transport-synthetic-test-secret-0123456789";
const signBody = (body: string) => `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
const signed = (payload: unknown) => signBody(Buffer.from(JSON.stringify(payload)).toString("base64url"));
function claims(viewReports = false) {
  const financeAccess = financeAccessFor("accountant", { viewReports });
  return { userId: 7, username: "synthetic-accountant", role: "accountant", expiresAt: NOW + 60_000,
    credentialVersion: sessionCredentialVersion("synthetic-password-hash"), financeAccess,
    permissionVersion: sessionPermissionVersion("accountant", financeAccess) };
}
function currentUser(viewReports = false) {
  transport.user = { id: 7, username: "synthetic-accountant", passwordHash: "synthetic-password-hash", isActive: true,
    role: "accountant", permissions: { financeAccess: financeAccessFor("accountant", { viewReports }) } };
}
const request = () => new NextRequest("https://clinic.example.test/api/reports?report=daily", { headers: {
  ...(transport.authorization === undefined ? {} : { authorization: transport.authorization }),
  ...(transport.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${encodeURIComponent(transport.cookie)}` }),
} });
async function throughProxyAndRoute() {
  const req = request();
  const gate = await proxy(req);
  return gate.headers.get("x-middleware-next") === "1" ? report(req) : gate;
}
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  transport.cookie = undefined;
  transport.authorization = `Bearer ${createSessionToken(claims())}`;
  currentUser();
  transport.findUser.mockReset().mockImplementation(async () => transport.user);
  transport.buildReport.mockReset().mockResolvedValue({ syntheticClinicRevenue: 87654321 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("actual proxy, session and report handler transport agreement", () => {
  it("does not bypass a revoked report grant with an old cookie plus an extra segment", async () => {
    transport.cookie = `${createSessionToken(claims(true))}.ignored`;
    expect((await requireSession())?.financeAccess?.viewReports).toBe(false);
    expect((await proxy(request())).status).toBe(403);
    expect((await throughProxyAndRoute()).status).toBe(403);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });

  it.each(["cookie", "bearer"] as const)("enforces current report restrictions inside the handler for %s too", async mode => {
    const token = createSessionToken(claims());
    transport.cookie = mode === "cookie" ? token : undefined;
    transport.authorization = mode === "bearer" ? `Bearer ${token}` : undefined;
    expect((await report(request())).status).toBe(403);
    expect((await throughProxyAndRoute()).status).toBe(403);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });

  it.each(["cookie", "bearer"] as const)("keeps a currently authorized %s working", async mode => {
    currentUser(true);
    const token = createSessionToken(claims(true));
    transport.cookie = mode === "cookie" ? token : undefined;
    transport.authorization = mode === "bearer" ? `Bearer ${token}` : undefined;
    const response = await throughProxyAndRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { syntheticClinicRevenue: 87654321 }, generatedBy: "synthetic-accountant" });
    expect(transport.buildReport).toHaveBeenCalledOnce();
  });

  it("uses the cookie's identity and grants even when a different signed bearer is present", async () => {
    transport.cookie = createSessionToken(claims());
    transport.authorization = `Bearer ${createSessionToken({ ...claims(true), userId: 8, username: "other-accountant" })}`;
    expect(await readSessionPayload()).toMatchObject({ userId: 7, financeAccess: { viewReports: false } });
    expect((await throughProxyAndRoute()).status).toBe(403);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });

  it("an authorized cookie retains precedence over a restricted bearer", async () => {
    currentUser(true);
    transport.cookie = createSessionToken(claims(true));
    expect(await readSessionPayload()).toMatchObject({ financeAccess: { viewReports: true } });
    expect((await throughProxyAndRoute()).status).toBe(200);
  });

  it("a malformed cookie can still use a valid authorized bearer", async () => {
    currentUser(true);
    transport.cookie = `${createSessionToken(claims())}.ignored`;
    transport.authorization = `Bearer ${createSessionToken(claims(true))}`;
    expect(await readSessionPayload()).toMatchObject({ financeAccess: { viewReports: true } });
    expect((await throughProxyAndRoute()).status).toBe(200);
  });

  it("a canonical bearer is never admitted as a legacy report session", async () => {
    transport.authorization = `Bearer ${signed({ ...claims(true), durableIdentity: { invalid: true } })}`;
    expect(await requireSession()).toBeNull();
    expect((await throughProxyAndRoute()).status).toBe(401);
    expect(transport.findUser).not.toHaveBeenCalled();
    expect(transport.buildReport).not.toHaveBeenCalled();
  });

  it.each(["cookie", "bearer"] as const)("denies an authentic stale permission %s without using another transport", async mode => {
    const oldToken = createSessionToken(claims(true));
    transport.cookie = mode === "cookie" ? oldToken : undefined;
    transport.authorization = mode === "cookie" ? `Bearer ${createSessionToken(claims())}` : `Bearer ${oldToken}`;
    expect((await proxy(request())).status).toBe(200); // Optimistic gate; account state is checked by the handler.
    expect(await requireSession()).toBeNull();
    expect((await throughProxyAndRoute()).status).toBe(401);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });

  for (const mode of ["cookie", "bearer"] as const) {
    it.each(["password", "role", "disabled", "missing", "unavailable"])(`fails closed for a ${mode} with stale/unverifiable %s`, async change => {
      currentUser(true);
      const token = createSessionToken(claims(true));
      transport.cookie = mode === "cookie" ? token : undefined;
      transport.authorization = mode === "cookie" ? `Bearer ${createSessionToken(claims())}` : `Bearer ${token}`;
      if (change === "password") transport.user.passwordHash = "synthetic-new-password-hash";
      if (change === "role") transport.user.role = "cashier";
      if (change === "disabled") transport.user.isActive = false;
      if (change === "missing") transport.findUser.mockResolvedValue(null);
      if (change === "unavailable") transport.findUser.mockRejectedValue(new Error("synthetic database unavailable"));
      expect(await requireSession()).toBeNull();
      expect((await throughProxyAndRoute()).status).toBe(401);
      expect(transport.buildReport).not.toHaveBeenCalled();
    });
  }

  it.each(["authority", "staffAuthority", "durableIdentity"])("never downgrades a signed %s cookie to a legacy bearer", async marker => {
    // Even an expired/malformed canonical payload must retain selection, then fail admission.
    transport.cookie = signed({ ...claims(), expiresAt: NOW - 1, [marker]: { invalid: true } });
    expect(await readSessionPayload()).toBeNull();
    expect(await requireSession()).toBeNull();
    // A signed canonical cookie must not be replaced by the restricted legacy bearer in the gate either.
    expect((await proxy(request())).status).toBe(200);
    expect((await throughProxyAndRoute()).status).toBe(401);
    expect(transport.findUser).not.toHaveBeenCalled();
    expect(transport.buildReport).not.toHaveBeenCalled();
  });
});

const malformedTokens: [string, () => string][] = [
  ["extra segment", () => `${createSessionToken(claims(true))}.ignored`],
  ["trailing delimiter", () => `${createSessionToken(claims(true))}.`],
  ["missing signature", () => `${createSessionToken(claims(true)).split(".")[0]}.`],
  ["missing body", () => `.${createSessionToken(claims(true)).split(".")[1]}`],
  ["padded body", () => signBody(`${Buffer.from(JSON.stringify(claims(true))).toString("base64url")}=`)],
  ["body whitespace", () => signBody(` ${Buffer.from(JSON.stringify(claims(true))).toString("base64url")}`)],
  ["signature padding", () => `${createSessionToken(claims(true))}=`],
  ["signature mismatch", () => `${createSessionToken(claims(true)).slice(0, -2)}xx`],
  ["oversize envelope", () => signed({ ...claims(true), padding: "x".repeat(32768) })],
  ["non JSON payload", () => signBody(Buffer.from("not-json").toString("base64url"))],
  ["array payload", () => signed([claims(true)])],
  ["null payload", () => signed(null)],
  ["expired payload", () => signed({ ...claims(true), expiresAt: NOW - 1 })],
  ["exact expiry", () => signed({ ...claims(true), expiresAt: NOW })],
  ["nonfinite expiry", () => signBody(Buffer.from(JSON.stringify(claims(true)).replace(String(NOW + 60_000), "1e400")).toString("base64url"))],
  ["string expiry", () => signed({ ...claims(true), expiresAt: String(NOW + 60_000) })],
  ["missing user id", () => signed({ ...claims(true), userId: undefined })],
  ["zero user id", () => signed({ ...claims(true), userId: 0 })],
  ["fractional user id", () => signed({ ...claims(true), userId: 7.5 })],
  ["unsafe user id", () => signed({ ...claims(true), userId: Number.MAX_SAFE_INTEGER + 1 })],
];
describe("strict envelope and legacy grammar parity", () => {
  it.each(malformedTokens)("rejects %s in both verifiers", async (_name, make) => {
    const token = make();
    expect(readSessionToken(token)).toBeNull();
    expect(await verifiedSessionRole(token)).toBeNull();
    expect(await verifiedSessionAccess(token)).toBeNull();
  });
  it.each(malformedTokens)("an invalid %s cookie falls back to the same restricted bearer", async (_name, make) => {
    transport.cookie = make();
    expect(await readSessionPayload()).toMatchObject({ userId: 7, financeAccess: { viewReports: false } });
    expect((await proxy(request())).status).toBe(403);
    expect((await throughProxyAndRoute()).status).toBe(403);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });
  it.each(malformedTokens)("an invalid %s bearer fails closed without a cookie", async (_name, make) => {
    transport.authorization = `Bearer ${make()}`;
    expect(await requireSession()).toBeNull();
    expect((await throughProxyAndRoute()).status).toBe(401);
    expect(transport.buildReport).not.toHaveBeenCalled();
  });
  it("shares strict signed JSON decoding, including invalid UTF-8", async () => {
    const bytes = Buffer.concat([Buffer.from('{"userId":7,"role":"accountant","expiresAt":1800000060000,"username":"'), Buffer.from([255]), Buffer.from('"}')]);
    const token = signBody(bytes.toString("base64url"));
    expect(readSignedSessionEnvelope(token)).toBeNull();
    expect(await verifiedSessionAccess(token)).toBeNull();
  });
});
