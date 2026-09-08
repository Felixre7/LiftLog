import { LocalDate } from '@js-joda/core';
import { MovementKey } from '@/models/blueprint-models';
import { Weight } from '@/models/weight';

/** Small all-history facts needed by the calendar, streaks and PR badges. */
export interface SessionActivitySummary {
  id: string;
  date: LocalDate;
  referenceTime: number;
  isStarted: boolean;
  volume: number;
  bests: { key: MovementKey; exerciseName: string; oneRepMax: Weight }[];
}

export interface SessionActivityJSON {
  isStarted: boolean;
  volume: number;
  bests: { key: MovementKey; exerciseName: string; oneRepMax: ReturnType<Weight['toJSON']> }[];
}
