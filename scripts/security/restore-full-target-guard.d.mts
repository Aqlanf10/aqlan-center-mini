export interface CheckedRestoreFullTarget {
  connectionString: string;
  host: string;
  database: string;
  local: boolean;
}
export function validatedRestoreFullTarget(
  raw: string,
  env?: NodeJS.ProcessEnv,
): CheckedRestoreFullTarget;
