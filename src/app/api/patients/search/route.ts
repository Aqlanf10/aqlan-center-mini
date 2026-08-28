import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/guards";
import { searchPatientOptions } from "@/server/patients/queries";

/**
 * Guarded patient-search endpoint backing the appointment form combobox.
 * Authenticated staff only; returns a small payload (never the full list).
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const options = await searchPatientOptions(q);
    return NextResponse.json({ options });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
