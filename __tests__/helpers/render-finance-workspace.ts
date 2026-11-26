import type { ReactElement } from "react";
import FinancePage from "../../app/finance/page";

// These hook harnesses manually render one component at a time. Follow the
// role selector once so assertions inspect the actual selected workspace.
export default function renderFinanceWorkspace(): ReactElement {
  const selected = FinancePage();
  if (typeof selected.type !== "function") return selected;
  return (selected.type as () => ReactElement)();
}
