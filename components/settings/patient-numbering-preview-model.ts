/** Server-authored active values. The client never formats or advances next. */
export type NumberingDisplaySnapshot = Readonly<{ prefix: string; next: string; revision: string }>;
