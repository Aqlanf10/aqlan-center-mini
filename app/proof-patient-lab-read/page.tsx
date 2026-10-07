import { requireSession } from "@/lib/session";
import { notFound } from "next/navigation";
import { PatientLabReadProof } from "./ProofClient";

// TEMPORARY PROOF ROUTE. This file is excluded from the clinical release tree.
// It deliberately cannot render outside the exact disposable HTTP harness.
export const dynamic = "force-dynamic";
export default async function Page() {
  if (process.env.PATIENT_LAB_READ_PROOF !== "20261007"
    || process.env.GITHUB_ACTIONS !== "true"
    // The unchanged security harness explicitly uses CI=false for its server;
    // the owning proof runner separately requires CI=true before any execution.
    || process.env.CI !== "false"
    || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
    || process.env.GITHUB_JOB !== "patient_lab_read_proof"
    || Object.keys(process.env).some((key) => key.startsWith("RAILWAY_"))) return notFound();
  let database: URL;
  try { database = new URL(process.env.DATABASE_URL ?? ""); } catch { return notFound(); }
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1"
    || database.port !== "5432" || database.pathname !== "/aqlan_sec_http") return notFound();
  const session = await requireSession();
  if (session?.username !== "secadmin" || session.role !== "admin") return notFound();
  return <PatientLabReadProof />;
}
