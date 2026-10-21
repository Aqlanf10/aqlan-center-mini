export declare function validateFinanceLifecycleTarget(
  environment: Readonly<Record<string, string | undefined>>,
): URL;
export declare function runFinanceLifecycle(
  environment?: Readonly<Record<string, string | undefined>>,
): Promise<number>;
