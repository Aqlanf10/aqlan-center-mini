/**
 * Pure, non-connecting URL guard for the expense-comparison TEMP fixture.
 * pg-connection-string allows query fields to override authority fields, so a
 * loopback URL hostname alone does not establish a loopback connection.
 */
export function assertLocalExpenseComparisonUrl(connectionString: string): string {
  const message = "Expense comparison fixtures require an explicitly local PostgreSQL test target.";
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    // URL parser errors can retain the input, including credentials.
    throw new Error(message);
  }
  if (!["postgres:", "postgresql:"].includes(target.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      || [...target.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error(message);
  }
  return connectionString;
}
