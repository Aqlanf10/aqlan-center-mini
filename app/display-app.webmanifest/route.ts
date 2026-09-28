import { getSettingsSafe } from "@/lib/db";
import { displayAppManifest } from "@/lib/display-app-manifest";
import { ICONS_VERSION } from "@/lib/icons-version.generated";

export const dynamic = "force-dynamic";

/** (INSTALL-1) بيان تطبيق شاشة الصالة — عامٌّ كبيان تطبيق الطاقم: لا يقرأ إلا اسم المركز. */
export async function GET() {
  const settings = await getSettingsSafe();
  return new Response(JSON.stringify(displayAppManifest(settings["clinic.name"], ICONS_VERSION)), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
