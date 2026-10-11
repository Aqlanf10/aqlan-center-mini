export interface LinkageEvidenceSuite { marker: string; files: string[] }
export const linkageEvidence: LinkageEvidenceSuite[];
export function missingLinkageEvidence(outcome: string, present: ReadonlySet<string>): string[];
export function verifyLinkageEvidence(outcome: string): Promise<void>;
