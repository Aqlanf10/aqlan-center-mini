import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { PageHeader } from "@/components/shared/page-header";
import { ClinicSettingsForm } from "@/components/settings/clinic-settings-form";
import { getClinicSettingsValues } from "@/server/settings/queries";

export const dynamic = "force-dynamic";

export default async function ClinicSettingsPage() {
  await requireRole(["ADMIN"], "/settings/clinic");
  const { dict } = await getI18n();
  const values = await getClinicSettingsValues();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={dict.settingsClinic.title} subtitle={dict.settingsClinic.subtitle} />
      <ClinicSettingsForm initial={values} />
    </div>
  );
}
