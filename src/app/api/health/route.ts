import { NextResponse } from "next/server";

import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness + database readiness probe for Railway health checks.
 *
 * Returns 200 when the app is up and PostgreSQL answers `select 1`,
 * 503 when the database is unreachable. Never exposes connection
 * strings, hostnames, credentials, or stack traces.
 */
export async function GET() {
  const timestamp = new Date().toISOString();

  try {
    await db.execute("select 1");
    return NextResponse.json(
      { status: "ok", database: "connected", timestamp },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unreachable", timestamp },
      { status: 503 }
    );
  }
}
