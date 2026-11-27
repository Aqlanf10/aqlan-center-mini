import { beforeEach, expect, it, vi } from "vitest";
import type { AiToolContext } from "../lib/ai-tools/types";

const m = vi.hoisted(() => ({ execute: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/ai-tools/registry", () => ({ executeAiTool: m.execute }));
vi.mock("@/lib/assistant-patient-link", () => ({ findAuthorizedPatientLink: m.open }));

import { processAssistantQuery } from "../lib/assistant-engine";
import { buildConfirmationPreview } from "../lib/ai-tools/confirmation-preview";

const context: AiToolContext = {
  userId: 2, username: "synthetic-reception", role: "reception", isDbConnected: true, todayISO: "2026-11-27",
};

beforeEach(() => vi.resetAllMocks());

it("routes 'open file' to authorized navigation, not patient registration", async () => {
  m.open.mockResolvedValue({ success: true, textSummary: "وجدت الملف.", actions: [{ href: "/patients/303", label: "فتح ملف المريض", actionType: "navigate" }] });
  const result = await processAssistantQuery("افتح ملف المريض P-00303", context);
  expect(result.intent).toBe("open_existing_patient");
  expect(m.open).toHaveBeenCalledWith("P-00303", context);
  expect(result.actions?.[0].href).toBe("/patients/303");
  expect(m.execute).not.toHaveBeenCalled();
});

it("asks for details when the booking time is absent instead of guessing from the date", async () => {
  const result = await processAssistantQuery("احجز موعد للمريض مثال في 2026-11-29", context);
  expect(result.intent).toBe("booking_details_needed");
  expect(m.execute).not.toHaveBeenCalled();
});

it("forwards the explicit appointment date and time to the confirmation path", async () => {
  m.execute.mockResolvedValue({ success: true, textSummary: "راجع الحجز ثم أكّد." });
  const result = await processAssistantQuery("احجز موعد للمريض مثال بكرة الساعة ٤ عصرًا", context);
  expect(result.intent).toBe("action_book_appointment");
  expect(m.execute).toHaveBeenCalledWith("book_appointment",
    expect.objectContaining({ date: "2026-11-28", time: "16:00" }), context);
});

it("distinguishes the file number, ISO date and 24-hour time", async () => {
  m.execute.mockResolvedValue({ success: true, textSummary: "راجع الحجز." });
  await processAssistantQuery("احجز موعد للمريض رقم الملف P-00303 يوم 2026-11-29 الساعة 04:00", context);
  expect(m.execute).toHaveBeenCalledWith("book_appointment",
    expect.objectContaining({ date: "2026-11-29", time: "04:00", patientName: "P-00303" }), context);
});

it.each([["٤ فجرًا", "04:00"], ["١٢ ليلًا", "00:00"], ["١٢ ظهرًا", "12:00"], ["٤ مساءً", "16:00"]])(
  "passes %s unchanged to the signed-booking preview as %s",
  async (spoken, expected) => {
    m.execute.mockResolvedValue({ success: true, textSummary: "راجع الحجز." });
    await processAssistantQuery("احجز موعد للمريض P-00303 بكرة الساعة " + spoken, context);
    expect(m.execute).toHaveBeenCalledTimes(1);
    const [tool, params] = m.execute.mock.calls[0];
    const preview = buildConfirmationPreview(tool, params, { id: 303, name: "اسم اصطناعي" });
    expect(preview.fields).toContainEqual({ label: "الوقت", value: expected });
    expect(preview.fields).toContainEqual({ label: "التاريخ", value: "2026-11-28" });
  },
);

it.each(["٤", "١٢", "٤ ليلًا", "٠٤:٦٠", "٠٤:٠٠ أو ١٦:٠٠"])(
  "asks for a single valid 24-hour time rather than guessing %s",
  async spoken => {
    const result = await processAssistantQuery("احجز موعد للمريض P-00303 بكرة الساعة " + spoken, context);
    expect(result.intent).toBe("booking_details_needed");
    expect(m.execute).not.toHaveBeenCalled();
  },
);
