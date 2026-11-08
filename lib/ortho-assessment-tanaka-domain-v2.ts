/** Versioned numerical admission only. The 1974 approximation and all measured
 * and predicted quantities retain v1 arithmetic. The domain is a product policy,
 * not a clinical normal range: see Tanaka & Johnston1974, pp799, Tables3–4.
 * Compare the exact decimal values represented by the accepted numeric inputs.
 * No clinical rounding, epsilon, or change to historical v1 reconstruction. */
import { tanakaArchSpace } from "./ortho-assessment-tanaka-1974-v1";

export const TANAKA_DECIMAL_DOMAIN_POLICY = "tanaka_whole_arch_mixed_decimal_v2" as const;

function withinExactDecimalDomain(values: readonly number[]): boolean {
  const decimals = values.map(value => {
    // Caller has already rejected non-finite/non-positive inputs. toString is
    // the canonical decimal retained across JSON storage and browser readback;
    // it also supports finite values serialized in exponential notation.
    const [significand, exponent = "0"] = value.toString().split("e");
    const [whole, fraction = ""] = significand.split(".");
    return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  });
  const scale = Math.max(1, ...decimals.map(decimal => decimal.scale));
  const sum = decimals.reduce((sum, decimal) => sum + decimal.coefficient * 10n ** BigInt(scale - decimal.scale), 0n);
  const tenths = 10n ** BigInt(scale - 1);
  return sum >= 205n * tenths && sum <= 270n * tenths;
}

export function tanakaArchSpaceWithDecimalDomainV2(...args: Parameters<typeof tanakaArchSpace>): ReturnType<typeof tanakaArchSpace> {
  const calculated = tanakaArchSpace(...args);
  if (!calculated.ok) return calculated;
  return { ok: true, value: { ...calculated.value,
    withinPublishedTablePredictorDomain: withinExactDecimalDomain(args[1].map(row => row.value)) } };
}
