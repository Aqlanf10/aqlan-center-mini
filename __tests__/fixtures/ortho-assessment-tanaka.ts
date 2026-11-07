import { assessmentCommandV2 } from "./ortho-assessment-schema2";
/** Entirely synthetic; no lecture patient or population measurement is reused. */
export function tanakaCommandV2() {
  const command = assessmentCommandV2();
  command.commandId = "synthetic_tanaka_command_1974";
  for (const row of command.content.observations.observations) {
    if (row.id === "dentition") row.value = { state: "recorded", text: "mixed" };
    if (["width_31", "width_32", "width_41", "width_42"].includes(row.id)) row.value = { state: "measured", value: 5.5 };
    if (["width_11", "width_21"].includes(row.id)) row.value = { state: "measured", value: 8 };
    if (["width_12", "width_22"].includes(row.id)) row.value = { state: "measured", value: 7 };
    if (row.target.kind === "tooth" && [13, 14, 15, 23, 24, 25, 33, 34, 35, 43, 44, 45].includes(row.target.tooth))
      row.value = { state: "not_erupted", reason: "Synthetic documented eruption state" };
    if (row.id === "available_upper") row.value = { state: "measured", value: 72 };
    if (row.id === "available_lower") row.value = { state: "measured", value: 63 };
  }
  command.content.analyses = [
    { state: "draft", id: "mixed_upper", measurementSetId: "current", method: "tanaka_johnston_1974", arch: "upper" },
    { state: "draft", id: "mixed_lower", measurementSetId: "current", method: "tanaka_johnston_1974", arch: "lower" },
  ];
  return command;
}
