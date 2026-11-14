import type {
  ReferenceAction,
  ReferenceInput,
} from "../inventory-reference-protocol";
import { invariant, quantityAtoms, unitConversionSnapshot } from "./quantities";
const actions: readonly ReferenceAction[] = [
  "item.create",
  "unit.revise",
  "location.create",
  "policy.revise",
];
export const referenceText = (
  v: unknown,
  max: number,
  field: string,
  empty = false,
): string => {
  invariant(
    typeof v === "string" &&
      v === v.trim() &&
      v.length <= max &&
      (empty || v.length > 0),
    "invalid_document",
    `Invalid ${field}`,
  );
  return v;
};
export const referenceInteger = (v: unknown, min: number, max: number) =>
  invariant(
    Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max,
    "invalid_document",
    "Invalid integer",
  );
export function validateReferenceInput(input: ReferenceInput) {
  invariant(
    input && actions.includes(input.action),
    "invalid_document",
    "Unknown setup action",
  );
  const keys: Record<ReferenceAction, readonly string[]> = {
    "item.create": [
      "action",
      "name",
      "category",
      "baseUnit",
      "basePrecision",
      "minLevel",
      "note",
      "reason",
    ],
    "unit.revise": [
      "action",
      "itemId",
      "expectedVersion",
      "enteredUnit",
      "factor",
      "enteredPrecision",
      "basePrecision",
      "reason",
    ],
    "location.create": [
      "action",
      "id",
      "label",
      "kind",
      "doctorPartyId",
      "reason",
    ],
    "policy.revise": ["action", "expectedVersion", "limitMinor", "reason"],
  };
  invariant(
    Object.keys(input).length === keys[input.action].length &&
      keys[input.action].every((k) => Object.hasOwn(input, k)),
    "invalid_document",
    "Unknown or missing setup fields",
  );
  referenceText(input.reason, 2000, "reason");
  invariant(
    input.reason.length >= 3,
    "reason_required",
    "A setup reason is required",
  );
  switch (input.action) {
    case "item.create":
      referenceText(input.name, 120, "name");
      referenceText(input.category, 40, "category");
      referenceText(input.baseUnit, 20, "base unit");
      referenceText(input.note, 300, "note", true);
      referenceInteger(input.basePrecision, 0, 3);
      quantityAtoms(input.minLevel, 3, true);
      break;
    case "unit.revise":
      referenceInteger(input.itemId, 1, Number.MAX_SAFE_INTEGER);
      referenceInteger(input.expectedVersion, 0, 2147483646);
      referenceText(input.enteredUnit, 80, "package unit");
      unitConversionSnapshot({
        itemId: input.itemId,
        version: input.expectedVersion + 1,
        enteredUnit: input.enteredUnit,
        baseUnit: "validated-in-transaction",
        baseUnitsPerEnteredUnit: input.factor,
        enteredPrecision: input.enteredPrecision,
        basePrecision: input.basePrecision,
      });
      break;
    case "location.create":
      referenceText(input.id, 80, "location identifier");
      referenceText(input.label, 120, "location label");
      invariant(
        /^[a-z][a-z0-9_.:-]{2,79}$/.test(input.id) &&
          ["store", "transit", "custody"].includes(input.kind),
        "invalid_document",
        "Invalid location",
      );
      if (input.kind === "custody")
        referenceInteger(input.doctorPartyId, 1, Number.MAX_SAFE_INTEGER);
      else
        invariant(
          input.doctorPartyId === null,
          "invalid_document",
          "Only custody has a doctor binding",
        );
      break;
    case "policy.revise":
      referenceInteger(input.expectedVersion, 0, 2147483646);
      referenceInteger(input.limitMinor, 0, Number.MAX_SAFE_INTEGER);
      break;
  }
}
