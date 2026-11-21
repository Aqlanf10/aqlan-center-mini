/** Unsaved clinical fields never belong in an official prescription URL. */
export const LEGACY_RX_DRAFT_KEYS = ["draft", "items", "diagnosis", "notes"] as const;
