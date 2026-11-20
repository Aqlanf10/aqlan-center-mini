import "server-only";
import type { Pool, PoolClient } from "pg";
import type { BoundRequestSession } from "./patient-numbering-request-session";
import { boundOwnerRelationship, type TrustedOwnerContext } from "./staff-capabilities";
import type { NumberingDispositionDependencies, NumberingEnrollment } from "./patient-numbering-disposition";
import { createNumberingOwnerSessionProvider } from "./patient-numbering-owner-session";
import { lockManagedNumberingGeneration, validManagedNumberingGeneration, type ExpectedManagedNumberingGeneration } from "./patient-numbering-managed-generation";
import { PatientNumberingPostgresBackend } from "./patient-numbering-postgres";
import { createPatientNumberingSettings } from "./patient-numbering-settings";

type Compose = NonNullable<Parameters<typeof createPatientNumberingSettings>[0]>;
interface BoundNumberingAuthority {
  owner: TrustedOwnerContext;
  enrollment: NumberingEnrollment;
}
export interface BoundSettingsDependencies {
  pool: Pool;
  schema: string;
  request: BoundRequestSession;
  /** Exact externally approved MANAGED generation, never sourced from HTTP or an archive. */
  managedGeneration: ExpectedManagedNumberingGeneration;
  /** Resolve canonical owner and immutable enrollment together on this locked client. */
  readLockedAuthority: (client: PoolClient) => Promise<BoundNumberingAuthority | null>;
  issuePreview: Compose["issuePreview"];
  verifyPreview: Compose["verifyPreview"];
}
const schemaId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

/** Uninstalled. The bound surface is durable-only; abstract/legacy controller
 * injection is not a supported fallback. All providers are trusted server
 * dependency seams, not request data, a recovery proof, or magic auth flags. */
export function bindPatientNumberingSettingsRequest(dependencies: BoundSettingsDependencies | null = null) {
  const managed = dependencies?.managedGeneration;
  if (!dependencies?.request || !validManagedNumberingGeneration(managed)
    || typeof dependencies.pool?.connect !== "function" || !schemaId(dependencies.schema)
    || typeof dependencies.readLockedAuthority !== "function"
    || typeof dependencies.issuePreview !== "function" || typeof dependencies.verifyPreview !== "function") {
    return createPatientNumberingSettings();
  }
  const { pool, schema, request, readLockedAuthority, issuePreview, verifyPreview } = dependencies;
  const exactManaged = Object.freeze({ ...managed });
  const { lineage } = exactManaged;
  async function loadAuthority(client: PoolClient) {
    const binding = await readLockedAuthority(client);
    const enrollment = binding?.enrollment;
    if (!binding || !enrollment || enrollment.lineage !== lineage || !identifier(enrollment.enrollment)
      || !Number.isSafeInteger(enrollment.actorId) || enrollment.actorId <= 0
      || boundOwnerRelationship(binding.owner, enrollment.actorId) !== "owner") return null;
    return { owner: binding.owner, enrollment: { ...enrollment } };
  }
  const disposition: NumberingDispositionDependencies = {
    admitBeforeConfig: client => lockManagedNumberingGeneration(client, exactManaged),
    enrollmentOnLockedClient: async client => (await loadAuthority(client))?.enrollment ?? null,
  };
  const backend = new PatientNumberingPostgresBackend({
    pool, schema, disposition,
    ownerSession: createNumberingOwnerSessionProvider(request, async client => (await loadAuthority(client))?.owner ?? null),
  });
  return createPatientNumberingSettings({ backend, issuePreview, verifyPreview, requireDisposition: true });
}
