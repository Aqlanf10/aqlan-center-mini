import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const page = readFileSync(path.join(root, "app/settings/backup/page.tsx"), "utf8");
const settings = readFileSync(path.join(root, "app/settings/page.tsx"), "utf8");
const deleteRoute = readFileSync(path.join(root, "app/api/settings/backup/archive/[backupId]/route.ts"), "utf8");
const restoreRoute = readFileSync(path.join(root, "app/api/settings/backup/restore/route.ts"), "utf8");

describe("واجهة إدارة النسخ والاستعادة", () => {
  it("مرتبطة من الإعدادات وتعرض النسخ والحذف والاستعادة", () => {
    expect(settings).toContain('href="/settings/backup"');
    expect(page).toContain("إدارة النسخ والاستعادة");
    expect(page).toContain("حذف النسخة");
    expect(page).toContain("اختبار الاستعادة");
    expect(page).toContain("READY FOR CUTOVER");
  });

  it("الحذف والاستعادة محميان في الخادم للمدير لا في الواجهة فقط", () => {
    for (const source of [deleteRoute, restoreRoute]) {
      expect(source).toContain("requireBackupAdminReadOnly");
      expect(source).toContain("isAdmin(auth.session.role)");
    }
    expect(deleteRoute).toContain("confirmation !== backupId");
    expect(restoreRoute).toContain("confirmation !== backupId");
  });

  it("الواجهة لا تدّعي أن الاستعادة تكتب فوق Production", () => {
    expect(page).toContain("Production لن يُلمس");
    expect(page).toContain("الاستعادة النهائية إلى Production لا تتم تلقائيًا");
  });
});
