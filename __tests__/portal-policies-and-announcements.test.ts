import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isClinicalImagingDocumentKind,
  maskPhoneForPortalDisplay,
} from "../lib/portal-data";
import {
  DEFAULT_PORTAL_SETTINGS,
  PORTAL_SETTINGS_BOUNDS,
  SANDBOX_SAMPLE_ANNOUNCEMENTS,
  isProductionLiveLaunchLocked,
  listPortalAnnouncementsForPublic,
  readPortalSettings,
  visibleSectionsFromSettings,
} from "../lib/portal-settings";

describe("Patient Portal Settings, Production Lock, Masking & Client Boundaries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to fail-closed disabled mode, hides X-ray documents by default, and retains deleted messages safely", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("USE_LOCAL_DB", "");
    vi.stubEnv("PATIENT_PORTAL_ACTIVATION_ENABLED", "");

    const settings = await readPortalSettings();
    expect(settings.operatingMode).toBe("disabled");
    expect(settings.effectiveOperatingMode).toBe("disabled");
    expect(settings.showDocuments).toBe(true);
    expect(settings.showXrayDocuments).toBe(false);
    expect(settings.deletedMessageRetentionMode).toBe(
      "retain_indefinitely_pending_owner_policy",
    );
    expect(settings.activationTtlMinutes).toBe(
      PORTAL_SETTINGS_BOUNDS.activationTtlMinutes.default,
    );
    expect(settings.maxFailedLoginAttempts).toBe(
      PORTAL_SETTINGS_BOUNDS.maxFailedLoginAttempts.default,
    );
  });

  it("hard-locks live launch in NODE_ENV=production unless explicitly unlocked by owner deployment flag", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("USE_LOCAL_DB", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_ALLOW_PRODUCTION_LIVE", "");

    expect(isProductionLiveLaunchLocked()).toBe(true);

    vi.stubEnv("PORTAL_ALLOW_PRODUCTION_LIVE", "true");
    expect(isProductionLiveLaunchLocked()).toBe(false);
  });

  it("cascades parent section toggles onto dependent sub-capabilities cleanly", () => {
    const base = {
      ...DEFAULT_PORTAL_SETTINGS,
      effectiveOperatingMode: "sandbox_test" as const,
      productionLaunchLocked: false,
      showAppointments: false,
      allowAppointmentConfirm: true,
      showBookingLink: true,
      showDocuments: false,
      showXrayDocuments: true,
      showMessages: false,
      allowMessageAttachments: true,
      allowVoiceMessages: true,
    };

    const visible = visibleSectionsFromSettings(base);
    expect(visible.appointments).toBe(false);
    expect(visible.allowAppointmentConfirm).toBe(false);
    expect(visible.showBookingLink).toBe(false);
    expect(visible.documents).toBe(false);
    expect(visible.xrayDocuments).toBe(false);
    expect(visible.messages).toBe(false);
    expect(visible.allowMessageAttachments).toBe(false);
    expect(visible.allowVoiceMessages).toBe(false);
  });

  it("shows sample announcements only in non-live modes and never in live_enabled mode", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("USE_LOCAL_DB", "");

    for (const sample of SANDBOX_SAMPLE_ANNOUNCEMENTS) {
      expect(sample.isSample).toBe(true);
      expect(sample.badgeLabel).toContain("نموذج تجريبي");
    }

    const sandboxItems = await listPortalAnnouncementsForPublic({
      ...DEFAULT_PORTAL_SETTINGS,
      operatingMode: "sandbox_test",
      effectiveOperatingMode: "sandbox_test",
      productionLaunchLocked: false,
      showAnnouncements: true,
    });
    expect(sandboxItems.length).toBeGreaterThan(0);
    expect(sandboxItems.every((item) => item.isSample)).toBe(true);

    const liveItems = await listPortalAnnouncementsForPublic({
      ...DEFAULT_PORTAL_SETTINGS,
      operatingMode: "live_enabled",
      effectiveOperatingMode: "live_enabled",
      productionLaunchLocked: false,
      showAnnouncements: true,
    });
    expect(liveItems).toEqual([]);
  });

  it("masks patient phone numbers safely and classifies clinical imaging document kinds", () => {
    expect(maskPhoneForPortalDisplay("774400401")).toBe("••• ••• 401");
    expect(maskPhoneForPortalDisplay("+967 774 400 401")).toBe("+967 ••• ••• 401");
    expect(maskPhoneForPortalDisplay("123")).toBeNull();
    expect(maskPhoneForPortalDisplay(null)).toBeNull();

    expect(isClinicalImagingDocumentKind("xray")).toBe(true);
    expect(isClinicalImagingDocumentKind("photo")).toBe(true);
    expect(isClinicalImagingDocumentKind("report")).toBe(false);
    expect(isClinicalImagingDocumentKind("consent")).toBe(false);
    expect(isClinicalImagingDocumentKind("other")).toBe(false);
  });

  it.each([
    "app/portal/page.tsx",
    "components/portal/PortalSections.tsx",
    "components/PortalAccountFlow.tsx",
  ])("keeps %s free of server-only DB and crypto imports", async (relPath) => {
    const src = await readFile(relPath, "utf8");
    expect(src).not.toContain('from "@/lib/db"');
    expect(src).not.toContain('from "@/lib/portal-security"');
    expect(src).not.toContain('from "@/lib/portal-settings"');
    expect(src).not.toContain('from "@/lib/portal-data"');
    expect(src).not.toContain("node:crypto");
  });
});
