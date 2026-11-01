export function staffIdentitySchemaName(value = "public") {
  if (typeof value !== "string" || (value !== "public" && !/^aqlan_identity_[a-f0-9]{16}$/.test(value))) throw new Error("STAFF_IDENTITY_SCHEMA_INVALID");
  return value;
}
