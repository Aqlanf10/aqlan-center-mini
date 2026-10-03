/** Nonremoved-document count metadata only; never grants document API or mutation access. */
export function workflowDocuments(snapshot: {
  documentsVisible?: unknown;
  counts?: { documents?: unknown } | null;
}): { documentsVisible: boolean | null; documents: number | null } {
  const documentsVisible = snapshot.documentsVisible === true ? true : snapshot.documentsVisible === false ? false : null;
  const value = snapshot.counts?.documents;
  return {
    documentsVisible,
    // Missing/legacy authority and malformed counts are unknown, never zero.
    documents: documentsVisible === true && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null,
  };
}

/** Unknown/denied reads must not make a no-documents assertion. */
export const WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE = "عدد المستندات غير متاح ضمن القراءة الحالية";
