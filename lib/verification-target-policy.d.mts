export type VerificationEnvironment = Readonly<Record<string, string | undefined>>;
export declare const RUNTIME_DATABASE_URL_ENV_NAMES: readonly [
  "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING",
];
export declare const GATE_DATABASE_URL_ENV_NAMES: readonly string[];
export declare const RAILWAY_ENV_NAMES: readonly string[];
export declare function isLoopbackHost(host: string): boolean;
export declare function looksLikeRailwayDatabaseHost(host: string): boolean;
export declare function validateLocalVerificationEnvironment(
  environment: VerificationEnvironment, errorPrefix?: string,
): void;
export declare function validateVerificationQueryParameters(url: URL): void;
export declare function validateLocalVerificationTarget(
  raw: string | undefined,
  environment: VerificationEnvironment,
  options: { varName: string; databaseName?: string; errorPrefix?: string },
): URL;
export declare function validateOperationalVerificationEnvironment(
  environment: VerificationEnvironment,
  options?: { requireSource?: boolean },
): string | undefined;
