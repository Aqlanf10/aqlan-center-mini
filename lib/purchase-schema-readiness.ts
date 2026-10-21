import expected from "../schema/purchase-receipts-readiness.pg18.json";
import type { DetailedSchemaCatalog, DetailedCatalogEntry } from "./schema-manifest";
import type { MigrationFile } from "./migration-files";

const TABLE = "inventory_purchase_receipts";
const FOREIGN_KEYS = ["inventory_purchase_receipts_actor_user_id_fkey", "inventory_purchase_receipts_movement_id_fkey"];
const FUNCTION = "aqlan_inventory_purchase_receipt_immutable";
export const PURCHASE_READINESS_SECTIONS = ["tables", "columns", "constraints", "indexes", "triggers", "internalTriggers", "functions"] as const;
type Section = typeof PURCHASE_READINESS_SECTIONS[number];
type Status = "ABSENT" | "MATCH" | "CONFLICT";
export function isPurchaseReadinessObject(section: Section, entry: DetailedCatalogEntry): boolean {
  return section === "functions" ? entry.name === FUNCTION : entry.table === TABLE || entry.key === TABLE
    || (section === "internalTriggers" && FOREIGN_KEYS.some(name => entry.key.includes(`:${name}:`)));
}
export interface PurchaseSchemaReadiness {
  formatVersion: 1;
  migrationVersion: "0065";
  expectedMigrationSha256: string;
  scope: "SOURCE_DERIVED_CATALOG_SHAPE_ONLY";
  excludedFromAssessment: readonly ["TABLE_OWNER_AND_ACL", "ROLE_PRIVILEGES", "RUNTIME_EXECUTION"];
  relation: Status;
  registry: Status;
  objects: Record<Section, Array<{ identity: string; status: Status }>>;
  unexpectedObjectCount: number;
  catalogShape: "ABSENT" | "COMPATIBLE" | "PARTIAL_OR_CONFLICTING";
  registrationAndShapeMatch: boolean;
  operationalAvailability: "NOT_VERIFIED";
  adoptionAssessment: "NOT_PERFORMED";
}

// Table ownership/ACL depends on the deployment role, not migration 0065.
// No ignored property is evidence of security equivalence or runtime readiness.
export function purchaseReadinessValue(section: Section, entry: DetailedCatalogEntry): string {
  const value = JSON.parse(entry.value) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog projection.");
  if (section === "tables") { delete value.owner; delete value.acl; }
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))));
}

/** Pure projection, no database API or arbitrary selectors. Never returns live definitions or their hashes. */
export function inspectPurchaseSchemaReadiness(catalog: DetailedSchemaCatalog,
  files: Pick<MigrationFile, "version" | "name" | "checksum">[],
  relationKinds: readonly string[]): PurchaseSchemaReadiness {
  const file = files.find(file => file.version === "0065");
  if (catalog.postgresMajor !== 18 || !file || file.name !== expected.migrationName || file.checksum !== expected.migrationSha256) {
    throw new Error("Purchase readiness provenance is unavailable.");
  }
  const relation: Status = relationKinds.length === 0 ? "ABSENT"
    : relationKinds.length === 1 && relationKinds[0] === "r" ? "MATCH" : "CONFLICT";
  const objects = {} as PurchaseSchemaReadiness["objects"];
  let unexpectedObjectCount = 0;
  for (const section of PURCHASE_READINESS_SECTIONS) {
    const entries = catalog[section];
    if (entries.length > 10_000) throw new Error("Purchase readiness catalog exceeds its bound.");
    const targets = expected.sections[section] as DetailedCatalogEntry[];
    objects[section] = targets.map(target => {
      const matches = entries.filter(entry => entry.key === target.key && entry.name === target.name && entry.table === target.table);
      let status: Status = "ABSENT";
      if (matches.length) {
        status = matches.length === 1 && purchaseReadinessValue(section, matches[0]) === target.value ? "MATCH" : "CONFLICT";
      }
      return { identity: target.key, status };
    });
    unexpectedObjectCount += entries.filter(entry =>
      isPurchaseReadinessObject(section, entry)
      && !targets.some(target => target.key === entry.key && target.name === entry.name && target.table === entry.table)).length;
  }
  const registrations = catalog.registry.rows.filter(row => row.version === "0065");
  const registry: Status = !registrations.length ? "ABSENT" : registrations.length === 1 && catalog.registry.present
    && registrations[0].checksum === file.checksum && registrations[0].name === file.name && !registrations[0].adopted ? "MATCH" : "CONFLICT";
  const statuses = Object.values(objects).flat().map(object => object.status);
  const catalogShape = relation === "ABSENT" && !unexpectedObjectCount && statuses.every(status => status === "ABSENT") ? "ABSENT"
    : relation === "MATCH" && !unexpectedObjectCount && statuses.every(status => status === "MATCH") ? "COMPATIBLE" : "PARTIAL_OR_CONFLICTING";
  return { formatVersion: 1, migrationVersion: "0065", expectedMigrationSha256: expected.migrationSha256,
    scope: "SOURCE_DERIVED_CATALOG_SHAPE_ONLY",
    excludedFromAssessment: ["TABLE_OWNER_AND_ACL", "ROLE_PRIVILEGES", "RUNTIME_EXECUTION"], relation, registry, objects, unexpectedObjectCount, catalogShape,
    registrationAndShapeMatch: registry === "MATCH" && catalogShape === "COMPATIBLE",
    operationalAvailability: "NOT_VERIFIED", adoptionAssessment: "NOT_PERFORMED" };
}
