import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/settings/backup/route";
import BackupRecoveryPage from "../app/settings/backup/page";
import { upsertBackupHistoryRecord } from "../lib/backupHistory";
import { backupStateDir, resolveBackupDirectory } from "../lib/backupVolume";
import { RESTORE_DRILL_STATE_FILE } from "../lib/restore/admin";

// Real GET handler, disk-history normalization and page callbacks. Only the
// app admission/connection boundary is mocked; no credentials, network or DB.
const fixture = vi.hoisted(() => ({ role: "admin", authenticated: true }));
vi.mock("../lib/backupReadOnly", () => ({
  requireBackupAdminReadOnly: async () => fixture.authenticated
    ? { ok: true, session: { role: fixture.role, username: "synthetic-admin" } }
    : { ok: false, reason: "no-session" },
  getBackupSettingsReadOnly: async () => ({ ok: false, reason: "settings-unreadable" }),
}));
vi.mock("../lib/files", () => ({ storageStatus: async () => ({ ready: false, directory: null }) }));
vi.mock("../lib/backupDestinations", () => ({ destinationProviders: () => [] }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));

// DOM-free, repo-style harness: execute the actual page's hooks and inspect
// actual JSX/status text. This is not rendered-browser or session evidence.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => {
  const real = await original<typeof import("react")>();
  const init = (value: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = value; return index; };
  return { ...real,
    useState(initial: unknown) {
      const index = init(initial); return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
    },
    useCallback(callback: unknown) { return hooks.slots[init(callback)]; },
    useEffect(effect: () => void) { const index = init(false); if (!hooks.slots[index]) { hooks.slots[index] = true; hooks.effects.push(effect); } },
  };
});

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && "props" in node
    ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  return typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node
      ? text((node as Element).props.children as ReactNode) : "";
}
function render() {
  hooks.cursor = 0;
  const tree = BackupRecoveryPage();
  hooks.effects.splice(0).forEach(effect => effect());
  return tree;
}
function click(label: string) {
  const button = nodes(render()).find(node => node.type === "button" && text(node) === label);
  expect(button?.props.disabled).toBe(false);
  (button!.props.onClick as () => void)();
}

const backupId = "production-backup-20260101-000000-001-synthetic-f00d1234.tar.gz";
const time = "2026-01-01T00:00:00.000Z";
const history = { backupId, requestedAt: time, completedAt: time, requestedBy: "synthetic-internal-only", targetEnvironment: "test", archiveSha256: "b".repeat(64), documentsVerified: 2, tablesCount: 42, durationMs: 1500, readyForCutover: true, errorCode: null };
const evidence = [
  ["ready", "reconciled", "unverified", "numbering-evidence-unverified", "أدلة عدّاد ملفات المرضى غير متحققة"],
  ["restored", "not-recorded", "not-recorded", "numbering-history-not-recorded", "النسخة لم تحفظ عدّاد ملفات المرضى"],
  ["restored", "reconciled", "reconciled", "numbering-freshness-unverified", "لم يُتحقق مستقلاً من الأرقام الأحدث"],
  ["restored", "future-unknown", "unverified", "numbering-evidence-unverified", "أدلة عدّاد ملفات المرضى غير متحققة"],
] as const;
let volume: string, statePath: string;
beforeEach(async () => {
  fixture.role = "admin"; fixture.authenticated = true;
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  volume = await mkdtemp(join(tmpdir(), "synthetic-backup-history-display-"));
  const backupDir = resolveBackupDirectory(volume);
  const stateDir = backupStateDir(backupDir);
  await mkdir(stateDir, { recursive: true });
  statePath = join(stateDir, RESTORE_DRILL_STATE_FILE);
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", volume);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("RESTORE_DRILL_DATABASE_URL", "postgresql://synthetic@127.0.0.1/backup_dst_synthetic");
  vi.stubEnv("RESTORE_DRILL_DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("RESTORE_DRILL_DEDICATED_TARGET", "true");
  await upsertBackupHistoryRecord(backupDir, {
    backupId, createdAt: time, triggerType: "manual", archiveSha256: "b".repeat(64), archiveBytes: 200,
    databaseSha256: "a".repeat(64), documentCount: 2, status: "verified", replicationStatus: "none", destinations: [],
  });
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (volume) await rm(volume, { recursive: true, force: true });
});

function interceptFetch(onRestore?: (init?: RequestInit) => Promise<Response>) {
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/backup" && init?.cache === "no-store") return GET();
    if (url === "/api/settings/backup/restore" && init?.method === "POST" && onRestore) return onRestore(init);
    throw new Error("Synthetic page rejected unrecognized network target");
  });
  vi.stubGlobal("fetch", transport); return transport;
}

describe("durable restore history is displayed without cutover approval", () => {
  it.each(evidence)("projects saved %s/%s through real GET and page", async (status, patientNumberSequence, expectedEvidence, cutoverBlocker, notice) => {
    const saved = JSON.stringify({ ...history, status, patientNumberSequence, cutoverBlocker: "synthetic-obsolete" });
    await writeFile(statePath, saved);
    const response = await GET(); const raw = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(raw).restore.lastDrill).toMatchObject({ status: "restored", backupId, documentsVerified: 2, tablesCount: 42,
      readyForCutover: false, patientNumberSequence: expectedEvidence, cutoverBlocker });
    expect(raw).not.toContain("synthetic-internal-only"); expect(raw).not.toContain(volume);
    expect(await readFile(statePath, "utf8")).toBe(saved);
    const transport = interceptFetch(); render();
    await vi.waitFor(() => expect(text(render())).toContain(notice));
    const shown = text(render());
    expect(shown).toContain("اكتملت الاستعادة المعزولة"); expect(shown).toContain("التحويل غير جاهز");
    expect(shown).toContain("2 مستند متحقق"); expect(shown).toContain("42 جدول");
    expect(shown).not.toContain("READY FOR CUTOVER"); expect(shown).not.toContain("synthetic-obsolete");
    expect(transport).toHaveBeenCalledExactlyOnceWith("/api/settings/backup", { cache: "no-store" });
  });
  it.each(["failed", "running"])("preserves %s without inventing evidence or completion", async status => {
    await writeFile(statePath, JSON.stringify({ ...history, status, patientNumberSequence: "reconciled" }));
    const response = await GET();
    expect((await response.json()).restore.lastDrill).toMatchObject({ status, readyForCutover: false, patientNumberSequence: "unverified", cutoverBlocker: null });
    interceptFetch(); render();
    await vi.waitFor(() => expect(text(render())).toContain(status === "running" ? "جارٍ الاختبار" : "فشل الاختبار"));
    expect(text(render())).not.toContain("اكتملت الاستعادة المعزولة");
  });
  it.each([[false, "admin", 401], [true, "doctor", 403]] as const)("does not send restore history when authorized=%s role=%s", async (authenticated, role, status) => {
    fixture.authenticated = authenticated; fixture.role = role;
    await writeFile(statePath, JSON.stringify({ ...history, status: "restored", patientNumberSequence: "reconciled" }));
    const response = await GET(); const raw = await response.text();
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(raw).not.toContain("lastDrill"); expect(raw).not.toContain(backupId);
  });
  it("shows isolated success and cutover hold after confirmation, then refreshes durable history", async () => {
    const cutoverBlocker = "numbering-history-not-recorded";
    const submit = vi.fn(async (init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ backupId, confirmation: backupId });
      await writeFile(statePath, JSON.stringify({ ...history, status: "restored", readyForCutover: false, patientNumberSequence: "not-recorded", cutoverBlocker }));
      return Response.json({ ok: true, readyForCutover: false, patientNumberSequence: "not-recorded", cutoverBlocker });
    });
    const transport = interceptFetch(submit); render();
    await vi.waitFor(() => expect(text(render())).toContain("اختبار الاستعادة"));
    click("اختبار الاستعادة"); expect(submit).not.toHaveBeenCalled(); click("تأكيد اختبار الاستعادة");
    await vi.waitFor(() => {
      expect(text(render())).toContain("اكتملت الاستعادة على الهدف المعزول.");
      expect(text(render())).toContain("النسخة لم تحفظ عدّاد ملفات المرضى");
      expect(text(render())).toContain("اكتملت الاستعادة المعزولة");
    });
    expect(submit).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledTimes(3);
    expect(text(render())).not.toContain("READY FOR CUTOVER");
  });
});
