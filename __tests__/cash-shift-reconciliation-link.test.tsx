import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CashShiftTab, type ShiftData } from "@/components/finance/CashShiftTab";
import type { SessionInfo } from "@/components/SessionProvider";
import { parseDoctorPermissions } from "@/lib/doctor-permissions";
import { ACCOUNTANT_FINANCE_ACCESS, CASHIER_FINANCE_ACCESS } from "@/lib/finance-permissions";

const fixture = vi.hoisted(() => ({ session: null as SessionInfo | null }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => fixture.session }));

const amounts = { YER: 0, SAR: 0, USD: 0 };
const open: ShiftData = {
  id: 101, openedAt: "2026-11-23T09:00:00.000Z", openedBy: "synthetic-user", opening: amounts,
  closedAt: null, closedBy: null, counted: null, note: null, status: "open",
};
const closed: ShiftData = {
  ...open, id: 100, closedAt: "2026-11-23T08:00:00.000Z", closedBy: "synthetic-user", counted: amounts, status: "closed",
};
const reconciliationLink = 'href="/finance/reconciliation"';

function render(session: SessionInfo | null, options?: { noOpenShift?: boolean; noHistory?: boolean }) {
  fixture.session = session;
  const desk = session?.role === "reception" || session?.role === "cashier";
  return renderToStaticMarkup(
    <CashShiftTab canMutate={desk} isAdmin={session?.role === "admin"} busy={false}
      shift={options?.noOpenShift ? null : open} recentShifts={options?.noHistory ? [] : [closed]}
      baseCurrency="YER" expectedInBox={null} payments={[]} expenses={[]} parties={[]}
      onOpenShift={vi.fn()} onCloseShift={vi.fn()} onCreateExpense={vi.fn()}
      onRemoveExpense={vi.fn()} onOpenQuickCollect={vi.fn()}
      lastVoucherId={null} onClearLastVoucher={vi.fn()} lastReceiptId={desk ? 42 : null}
      onClearLastReceipt={vi.fn()} spending={false} setSpending={vi.fn()} closing={false} setClosing={vi.fn()}
    />,
  );
}

describe("full reconciliation is not an ordinary cash desk action", () => {
  it("shows the existing destination to an administrator and to an authorized legacy accountant", () => {
    for (const session of [
      { username: "synthetic-admin", role: "admin" },
      { username: "synthetic-accountant-default", role: "accountant" },
      { username: "synthetic-accountant-granted", role: "accountant", permissions: parseDoctorPermissions({ financeAccess: ACCOUNTANT_FINANCE_ACCESS }, "accountant") },
    ]) {
      expect(render(session)).toContain(reconciliationLink);
      expect(render(session, { noHistory: true })).not.toContain(reconciliationLink);
    }
  });

  it("hides it after an accountant's read grant is removed or identity is unavailable", () => {
    const accountant = { username: "synthetic-accountant", role: "accountant" };
    expect(render(accountant)).toContain(reconciliationLink);
    expect(render({
      ...accountant, permissions: parseDoctorPermissions({ financeAccess: { viewReconciliation: false } }, "accountant"),
    })).not.toContain(reconciliationLink);
    expect(render(null)).not.toContain(reconciliationLink);
  });

  it.each(["reception", "cashier"])("for %s hides only the full link, preserving shift operations, collection and receipt printing", role => {
    const desk = { username: "synthetic-desk", role, permissions: {
      ...parseDoctorPermissions(null, role), financeAccess: { ...CASHIER_FINANCE_ACCESS, viewReconciliation: true },
    } };
    const current = render(desk);
    expect(current).not.toContain(reconciliationLink);
    expect(current).toContain("سجل الورديات السابقة المغلقة");
    expect(current).toContain("إغلاق الوردية");
    expect(current).toContain(">سند قبض<");
    expect(current).toContain('href="/print/receipt/42"');
    const noOpen = render(desk, { noOpenShift: true });
    expect(noOpen).toContain("افتح وردية الصندوق الآن");
    expect(noOpen).not.toContain(reconciliationLink);
  });
});
