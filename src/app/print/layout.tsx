import { getClinicSettingsValues } from "@/server/settings/queries";
import { getI18n } from "@/i18n/server";

/**
 * Bare layout for print pages — no app chrome (sidebar/header are not
 * rendered here at all), correct RTL from the root layout, and a shared
 * clinic identity header available to the sheets.
 */
export default async function PrintLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [{ dict }, clinic] = await Promise.all([
    getI18n(),
    getClinicSettingsValues(),
  ]);
  const brandName = clinic.displayName || dict.app.centerName;

  return (
    <div className="min-h-svh bg-white">
      {/* Clinic identity masthead shared by every print sheet. */}
      <div className="print-hide bg-muted/40 border-b py-2 text-center">
        <p className="text-sm font-semibold">{brandName}</p>
      </div>
      <main className="p-4 print:p-0">{children}</main>
    </div>
  );
}
