import type { Locale } from "@/i18n/config";
import { ar, type Dictionary } from "./ar";
import { en } from "./en";

export const dictionaries: Record<Locale, Dictionary> = {
  ar,
  en,
};

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

export type { Dictionary };
