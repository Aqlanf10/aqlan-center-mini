"use client";

import { PrintBrandIdentity, PrintFooter, PrintHeader } from "./PrintHeader";
import { useSetting } from "./SettingsProvider";
import { SETTING_DEFAULTS, type SettingsMap } from "@/lib/settings";

function usePrintSettings(overrides: { clinicName?: string; clinicPhone?: string; clinicAddress?: string } = {}): SettingsMap {
  const name = useSetting("clinic.name");
  const doctor = useSetting("clinic.lead_doctor");
  const title = useSetting("clinic.lead_doctor_title");
  const credentials = useSetting("clinic.lead_doctor_credentials");
  const phone = useSetting("clinic.phone");
  const address = useSetting("clinic.address");
  return { ...SETTING_DEFAULTS, "clinic.name": overrides.clinicName ?? name, "clinic.lead_doctor": doctor,
    "clinic.lead_doctor_title": title, "clinic.lead_doctor_credentials": credentials,
    "clinic.phone": overrides.clinicPhone ?? phone, "clinic.address": overrides.clinicAddress ?? address };
}

type IdentityProps = {
  clinicName?: string; clinicPhone?: string; clinicAddress?: string; showContacts?: boolean;
  /** Kept for source compatibility; the approved contract owns identity geometry. */
  center?: boolean; logoClassName?: string;
};

/** Client adapter: same configured clinic identity as the approved contract.
 * No copied clinic details, extra reads, or changed document scope. */
export function ReportPrintIdentity({ clinicName, clinicPhone, clinicAddress, showContacts = true }: IdentityProps) {
  const settings = usePrintSettings({ clinicName, clinicPhone, clinicAddress });
  return <PrintBrandIdentity settings={settings} showContacts={showContacts} />;
}

export function ReportPrintHeader({ title, subtitle, clinicName, clinicPhone, clinicAddress, docMeta }: {
  title: string; subtitle?: string; clinicName?: string; clinicPhone?: string; clinicAddress?: string; docMeta?: string;
}) {
  const settings = usePrintSettings({ clinicName, clinicPhone, clinicAddress });
  return <div className="print-report-header" dir="rtl">
    <PrintHeader settings={settings} title={title} />
    {subtitle ? <p className="print-report-subtitle">{subtitle}</p> : null}
    {docMeta ? <p className="print-report-meta">{docMeta}</p> : null}
  </div>;
}

export function ReportPrintFooter({ clinicName, clinicPhone, clinicAddress }: {
  clinicName?: string; clinicPhone?: string; clinicAddress?: string;
} = {}) {
  const settings = usePrintSettings({ clinicName, clinicPhone, clinicAddress });
  return <div className="print-report-footer" dir="rtl"><PrintFooter settings={settings} /></div>;
}
