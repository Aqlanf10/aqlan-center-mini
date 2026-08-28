import Image from "next/image";

import { getClinicSettingsValues } from "@/server/settings/queries";
import { getI18n } from "@/i18n/server";

/** Printable clinic masthead: real logo + identity (A5/A4 sheets). */
export async function PrintMasthead({ subtitle }: { subtitle?: string }) {
  const [{ locale, dict }, clinic] = await Promise.all([
    getI18n(),
    getClinicSettingsValues(),
  ]);
  const brandName = clinic.displayName || dict.app.centerName;

  return (
    <header className="print-avoid-break flex items-center gap-3 border-b-2 border-black pb-3">
      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-white p-1">
        <Image
          src="/logo-icon.png"
          alt={brandName}
          width={48}
          height={48}
          className="size-full object-contain"
        />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-bold leading-tight">{brandName}</h1>
        <p className="text-xs">{dict.app.centerName}</p>
      </div>
      {subtitle ? (
        <p className="text-sm font-semibold" dir="auto">
          {subtitle}
        </p>
      ) : null}
      <span className="sr-only">{locale}</span>
    </header>
  );
}

/** Signature row used at the bottom of vouchers. */
export function SignatureRow({
  labels,
}: {
  labels: { recipient: string; accountant: string; approval: string };
}) {
  return (
    <div className="mt-10 grid grid-cols-3 gap-4 text-center text-xs">
      <div className="border-t border-dashed pt-2">{labels.recipient}</div>
      <div className="border-t border-dashed pt-2">{labels.accountant}</div>
      <div className="border-t border-dashed pt-2">{labels.approval}</div>
    </div>
  );
}
