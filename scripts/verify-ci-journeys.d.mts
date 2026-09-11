export interface Journey {
  phase: number;
  name: string;
  script: string;
  needsPostgres: boolean;
}
export declare const JOURNEYS: Journey[];
export declare const PHASE_TITLE: Record<number, string>;
