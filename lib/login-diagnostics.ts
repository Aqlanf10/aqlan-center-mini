/** Closed vocabulary: never pass exceptions or request data to a logger. */
export type LoginStage = "shared_limit" | "legacy_limit" | "user_lookup" | "password_verification" | "session" | "response";
const categories = ["ORTHO_UNREGISTERED_OBJECT_COLLISION", "ORTHO_MIGRATION_REGISTRY_MISMATCH", "ORTHO_MIGRATION_SOURCE_MISMATCH"] as const;
const versions = ["0051", "0052"] as const;

export function loginFailureDiagnostic(stage: LoginStage, error: unknown) {
  let message: unknown;
  // Accessors and non-Error values are not trusted diagnostic inputs.
  try { message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined; } catch { /* no diagnostic data */ }
  if (typeof message === "string") {
    for (const category of categories) {
      for (const version of versions) {
        if (message === `${category}: ${version}` || message.startsWith(`${category}: ${version}: `)) {
          return { event: "staff_login_failed", stage, category, version };
        }
      }
    }
  }
  return { event: "staff_login_failed", stage, category: "unclassified" };
}

export function reportLoginFailure(stage: LoginStage, error: unknown): void {
  try { console.error(JSON.stringify(loginFailureDiagnostic(stage, error))); } catch { /* logging cannot change the client response */ }
}
