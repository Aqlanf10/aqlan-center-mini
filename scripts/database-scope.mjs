export const AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID =
  "7f3b5a7b-4508-4b7f-be3d-ad268fc5675a";
export const AQLAN_CENTER_MINI_DATABASE_NAME = "aqlan_center_mini_v2";

function hasExplicitTrustedCa(environment) {
  return Boolean(
    environment.PGSSL_ROOT_CERT_PEM?.trim()
    || environment.PGSSL_ROOT_CERT?.trim(),
  );
}

export function databaseUrlForProject(rawConnectionString, environment = process.env) {
  const currentProjectId = environment.RAILWAY_PROJECT_ID?.trim();
  if (!currentProjectId) return rawConnectionString;
  if (currentProjectId !== AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID) {
    throw new Error(
      "تم إيقاف الاتصال بقاعدة البيانات: هذا الفرع يعمل فقط داخل مشروع Aqlan Center Mini على Railway.",
    );
  }
  const target = new URL(rawConnectionString);
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("رابط قاعدة البيانات ليس رابط PostgreSQL صالحًا.");
  }
  target.pathname = `/${AQLAN_CENTER_MINI_DATABASE_NAME}`;
  if (hasExplicitTrustedCa(environment)) {
    const sslmode = target.searchParams.get("sslmode")?.toLowerCase();
    if (sslmode !== "disable") {
      target.searchParams.delete("sslmode");
      target.searchParams.delete("sslcert");
      target.searchParams.delete("sslkey");
      target.searchParams.delete("sslrootcert");
    }
  }
  return target.toString();
}
