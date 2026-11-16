import { NextResponse } from "next/server";
import { resolvePortalDocumentDownload } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

function safeAsciiFilename(name: string): string {
  const clean = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").trim();
  return clean || "document";
}

/**
 * تنزيل مستند مملوك للمريض صاحب الجلسة فقط، مع فحص ملكية الصف ونوع المستند المسموح به.
 */
export async function GET(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  const url = new URL(request.url);
  const rawId = url.searchParams.get("id");
  const documentId = Number(rawId);
  if (!rawId || !Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ message: "معرّف المستند غير صالح." }, { status: 400 });
  }

  try {
    const settings = await readPortalSettings();
    const resolved = await resolvePortalDocumentDownload(documentId, session.patientId, settings);
    if (!resolved.ok) {
      return NextResponse.json(
        { code: resolved.code, message: resolved.message },
        { status: resolved.status },
      );
    }

    const ext =
      resolved.safeMime === "application/pdf"
        ? ".pdf"
        : resolved.safeMime === "image/png"
          ? ".png"
          : resolved.safeMime === "image/jpeg"
            ? ".jpg"
            : resolved.safeMime === "image/webp"
              ? ".webp"
              : "";
    const rawFileName = resolved.title.toLowerCase().endsWith(ext)
      ? resolved.title
      : `${resolved.title}${ext}`;
    const encodedUtf8 = encodeURIComponent(rawFileName);
    const ascii = safeAsciiFilename(rawFileName);

    return new Response(new Uint8Array(resolved.bytes), {
      status: 200,
      headers: {
        "Content-Type": resolved.safeMime,
        "Content-Length": String(resolved.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodedUtf8}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تنزيل المستند الآن." },
      { status: 500 },
    );
  }
}
