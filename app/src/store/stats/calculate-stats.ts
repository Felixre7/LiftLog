import { PotentialSet, RecordedWeightedExercise, Session } from '@/models/session-models';
import { ExerciseBlueprint, MovementKey } from '@/models/blueprint-models';
import { LocalDateRange } from '@/models/time-models';
import { Weight, WeightUnit } from '@/models/weight';
import {
  GranularStatisticView,
  HeaviestLift,
  OptionalStatisticOverTime,
  RepsBreakdownStatistics,
  StatisticOverTime,
  TimeTrackedStatistic,
  WeightedExerciseStatistics,
  WeightedStatisticOverTime,
} from '@/store/stats';
import { loadOps, QuantityOps, repsOps, StatAxis } from '@/store/stats/quantity';
import { Duration, LocalDate, OffsetDateTime, ZoneId } from '@js-joda/core';
import BigNumber from 'bignumber.js';
import Enumerable from 'linq';
import type { WorkCheckpoint } from '@/utils/cooperative-work';

/** Epley: 1RM = weight * (1 + reps/30). `weight` is the effective load, folding in bodyweight. */
export function calculateOneRepMax(ps: PotentialSet, weight: Weight): Weight {
  const reps = ps.set!.repsCompleted;
  return weight.multipliedBy(new BigNumber(1).plus(new BigNumber(reps).div(30)));
}

export function calculateStats(
  sessions: Session[],
  preferredUnit: WeightUnit,
  timeRange: LocalDateRange,
): GranularStatisticView {
  const calculation = calculateStatsSteps(sessions, preferredUnit, timeRange);
  let step = calculation.next();
  while (!step.done) step = calculation.next();
  return step.value;
}

/** Same calculation, with checkpoints so large histories do not monopolize the JS thread. */
export async function calculateStatsAsync(
  sessions: Session[],
  preferredUnit: WeightUnit,
  timeRange: LocalDateRange,
  checkpoint: WorkCheckpoint,
): Promise<GranularStatisticView> {
  const calculation = calculateStatsSteps(sessions, preferredUnit, timeRange);
  let step = calculation.next();
  while (!step.done) {
    const pause = checkpoint();
    if (pause) await pause;
    step = calculation.next();
  }
  return step.value;
}

function* calculateStatsSteps(
  sessions: Session[],
  preferredUnit: WeightUnit,
  timeRange: LocalDateRange,
): Generator<void, GranularStatisticView> {
  if (!sessions.length)
    return {
      workoutsPerWeek: 0,
      setsPerWeek: 0,
      averageSessionLength: Duration.ZERO,
      maxWeightLiftedInAWorkout: undefined,
      bodyweightStats: {
        statistics: [],
        currentValue: Weight.NIL,
        totalValue: Weight.NIL,
        minValue: Weight.NIL,
        maxValue: Weight.NIL,
      },
      weightedExerciseStats: [],
      heaviestLift: undefined,
      sessionStats: [],
    };

  yield;
  const zone = ZoneId.systemDefault();
  const noons = new Map<number, OffsetDateTime>();
  function noon(date: LocalDate) {
    const day = date.toEpochDay();
    let value = noons.get(day);
    if (!value) {
      value = date.atTime(12, 0).atZone(zone).toOffsetDateTime();
      noons.set(day, value);
    }
    return value;
  }
  // Only sessions with at least one exercise
  const sessionsWithExercises = sessions.filter((s) => s.recordedExercises.length > 0);
  const daysBetween = Enumerable.from(sessionsWithExercises)
    .select((c) => c.date)
    .distinct((x) => x.toString())
    .toArray();
  const workoutCount = sessionsWithExercises.length;
  const totalSets = sessionsWithExercises.reduce(
    (sessionTotal, session) =>
      sessionTotal +
      session.recordedExercises.reduce((exerciseTotal, exercise) => {
        if (exercise instanceof RecordedWeightedExercise) {
          return exerciseTotal + exercise.potentialSets.filter((set) => set.set !== undefined).length;
        }
        return exerciseTotal + exercise.sets.filter((set) => set.completionDateTime !== undefined).length;
      }, 0),
    0,
  );
  const totalDays = timeRange.to.toEpochDay() - timeRange.from.toEpochDay() + 1;
  const totalWeeks = Math.max(totalDays / 7, 1);
  const workoutsPerWeek = workoutCount / totalWeeks;
  const setsPerWeek = totalSets / totalWeeks;

  yield;
  const bodyWeightStatistics = Enumerable.from(sessions)
    .where((s) => !!s.bodyweight)
    .select((session) => ({
      dateTime: noon(session.date), // Use noon for LocalDate
      value: session.bodyweight!,
    }))
    .toArray();
  // --- Bodyweight stats over time ---
  const bodyweightStats: WeightedStatisticOverTime = yield* toStatisticOverTime(bodyWeightStatistics, loadOps);

  yield;
  // --- Session stats grouped by blueprint name ---
  const sessionStats: OptionalStatisticOverTime<Weight>[] = [];
  const sessionsByBlueprint = new Map<string, Session[]>();
  for (const session of sessionsWithExercises) {
    yield;
    const key = session.blueprint.name;
    if (!sessionsByBlueprint.has(key)) sessionsByBlueprint.set(key, []);
    sessionsByBlueprint.get(key)!.push(session);
  }
  const sortedDays = daysBetween
    .sort((a, b) => a.compareTo(b))
    .map((date) => ({
      key: date.toEpochDay(),
      dateTime: noon(date),
    }));
  for (const [name, group] of sessionsByBlueprint.entries()) {
    // Preserve the first workout on a date without repeatedly scanning the whole group.
    const firstByDate = new Map<number, Session>();
    for (const session of group) {
      const date = session.date.toEpochDay();
      if (!firstByDate.has(date)) firstByDate.set(date, session);
    }
    const statistics: TimeTrackedStatistic<Weight | undefined>[] = [];
    for (let index = 0; index < sortedDays.length; index++) {
      if (index % 32 === 0) yield;
      const date = sortedDays[index]!;
      const session = firstByDate.get(date.key);
      statistics.push({
        dateTime: date.dateTime,
        value: session ? session.totalWeightLifted : undefined,
      });
    }
    const statsWithValue = statistics.filter((x) => x.value !== undefined);
    const min = statsWithValue.length ? Weight.min(...statsWithValue.map((x) => x.value!)) : Weight.NIL;
    const max = statsWithValue.length ? Weight.max(...statsWithValue.map((x) => x.value!)) : Weight.NIL;
    sessionStats.push({
      title: name,
      statistics,
      minValue: min,
      maxValue: max,
    });
  }

  yield;
  // --- Exercise stats grouped by normalized exercise name ---
  interface ExerciseStatAcc {
    exerciseName: string;
    primary: StatAxis;
    maxWeightStatistics: TimeTrackedStatistic<Weight>[];
    maxRepsStatistics: TimeTrackedStatistic<number>[];
    max1RMStatistics: TimeTrackedStatistic<Weight>[];
    totalVolumeStatistics: TimeTrackedStatistic<Weight>[];
    repsStatistics: RepsBreakdownStatistics;
    latestTime: OffsetDateTime;
  }
  const exerciseStatsMap = new Map<MovementKey, ExerciseStatAcc>();
  let heaviestLift: HeaviestLift | undefined;

  for (const session of sessionsWithExercises) {
    yield;
    for (const ex of session.recordedExercises) {
      yield;
      const weighted =
        ex instanceof RecordedWeightedExercise ? summarizeWeightedExercise(ex, session.bodyweight) : undefined;
      if (weighted) {
        const weight =
          weighted.maxWeight && !Weight.NIL.isGreaterThan(weighted.maxWeight) ? weighted.maxWeight : Weight.NIL;
        if (!heaviestLift || weight.isGreaterThan(heaviestLift.weight))
          heaviestLift = { exerciseName: ex.blueprint.name, weight };
      }
      const blueprint = ex.blueprint;
      const key = blueprint.movementKey();
      if (!ex.isStarted) continue;
      if (!exerciseStatsMap.has(key)) {
        exerciseStatsMap.set(key, {
          exerciseName: blueprint.name,
          primary: primaryAxisFor(blueprint),
          maxWeightStatistics: [],
          maxRepsStatistics: [],
          max1RMStatistics: [],
          repsStatistics: { breakdown: {} },
          totalVolumeStatistics: [],
          latestTime: OffsetDateTime.MIN,
        });
      }
      if (!(ex instanceof RecordedWeightedExercise)) {
        continue;
      }
      const exerciseStats = exerciseStatsMap.get(key)!;
      const { maxWeight, max1RM, maxReps, volume, lastSet } = weighted!;
      if (!maxWeight || !max1RM) continue;

      for (const set of ex.potentialSets) {
        if (!set.set) {
          continue;
        }
        exerciseStats.repsStatistics.breakdown[set.set.repsCompleted] ??= {
          numberOfSets: 0,
        };
        exerciseStats.repsStatistics.breakdown[set.set.repsCompleted]!.numberOfSets += 1;
      }

      // We'll use the last set for this
      if (exerciseStats.latestTime.isBefore(lastSet!.set!.completionDateTime)) {
        exerciseStats.latestTime = lastSet!.set!.completionDateTime;
        // How the exercise is programmed now, not how it was the first time it was logged.
        exerciseStats.primary = primaryAxisFor(blueprint);
      }
      exerciseStats.maxWeightStatistics.push({
        dateTime: lastSet!.set!.completionDateTime,
        value: maxWeight,
      });
      exerciseStats.maxRepsStatistics.push({
        dateTime: lastSet!.set!.completionDateTime,
        value: maxReps,
      });
      exerciseStats.max1RMStatistics.push({
        dateTime: lastSet!.set!.completionDateTime,
        value: max1RM,
      });
      exerciseStats.totalVolumeStatistics.push({
        dateTime: lastSet!.set!.completionDateTime,
        value: volume,
      });
    }
  }

  yield;
  // Most recently performed first, so what the user is training now heads the list.
  const exerciseStats: WeightedExerciseStatistics[] = [];
  for (const ex of Array.from(exerciseStatsMap.values()).sort((a, b) =>
    a.latestTime.isEqual(b.latestTime) ? 0 : a.latestTime.isAfter(b.latestTime) ? -1 : 1,
  )) {
    yield;
    const maxLiftedPerSessionStatistics = yield* toStatisticOverTime(ex.maxWeightStatistics, loadOps);
    const max1RMPerSessionStatistics = yield* toStatisticOverTime(ex.max1RMStatistics, loadOps);
    exerciseStats.push({
      exerciseName: ex.exerciseName,
      setsPerWeek:
        Object.values(ex.repsStatistics.breakdown).reduce((accum, entry) => accum + entry.numberOfSets, 0) / totalWeeks,
      primary: ex.primary,
      series: {
        load: maxLiftedPerSessionStatistics,
        reps: yield* toStatisticOverTime(ex.maxRepsStatistics, repsOps),
      },
      maxLiftedPerSessionStatistics,
      max1RMPerSessionStatistics,
      totalVolumeStatistics: yield* toStatisticOverTime(ex.totalVolumeStatistics, loadOps),
      repsStatistics: ex.repsStatistics,
    } satisfies WeightedExerciseStatistics);
  }

  yield;
  // --- Average session length ---
  const sessionDurations: Duration[] = [];
  for (const session of sessionsWithExercises) {
    yield;
    const duration = session.duration;
    if (duration) {
      sessionDurations.push(duration);
    }
  }
  let averageSessionLength = Duration.ZERO;
  if (sessionDurations.length > 0) {
    averageSessionLength = sessionDurations
      .reduce((a, b) => a.plus(b), Duration.ZERO)
      .dividedBy(sessionDurations.length);
  }

  return {
    workoutsPerWeek,
    setsPerWeek,
    maxWeightLiftedInAWorkout: Weight.max(
      ...Enumerable.from(sessionStats)
        .defaultIfEmpty({
          maxValue: Weight.NIL,
          minValue: Weight.NIL,
          title: '',
          statistics: [],
        })
        .select((x) => x.maxValue)
        .toArray(),
    ).convertTo(preferredUnit),
    averageSessionLength,
    heaviestLift,
    weightedExerciseStats: exerciseStats,
    sessionStats,
    bodyweightStats,
  };
}

/** Fold each completed set once; bodyweight loads and BigNumber arithmetic are shared by all series. */
function summarizeWeightedExercise(ex: RecordedWeightedExercise, bodyweight: Weight | undefined) {
  let maxWeight: Weight | undefined;
  let max1RM: Weight | undefined;
  let maxReps = 0;
  let volume = Weight.NIL;
  let lastSet: PotentialSet | undefined;
  for (const potential of ex.potentialSets) {
    const set = potential.set;
    if (!set) continue;
    const weight = ex.effectiveWeight(potential, bodyweight);
    if (!maxWeight || !maxWeight.isGreaterThan(weight)) maxWeight = weight;
    if (set.repsCompleted) {
      const oneRepMax = calculateOneRepMax(potential, weight);
      if (!max1RM || !max1RM.isGreaterThan(oneRepMax)) max1RM = oneRepMax;
    }
    maxReps = Math.max(maxReps, set.repsCompleted);
    volume = weight.multipliedBy(set.repsCompleted).plus(volume);
    if (!lastSet || set.completionDateTime.isAfter(lastSet.set!.completionDateTime)) lastSet = potential;
  }
  return { maxWeight, max1RM, maxReps, volume, lastSet };
}

/**
 * Sort a series by time and roll up its extremes and total. Parametric over the axis's arithmetic,
 * so a rep count aggregates by the same code as a load without ever being treated as a mass.
 */
function* toStatisticOverTime<T>(
  unsortedStats: TimeTrackedStatistic<T>[],
  ops: QuantityOps<T>,
): Generator<void, StatisticOverTime<T>> {
  const statistics = Enumerable.from(unsortedStats)
    .orderBy((x) => x.dateTime.toString())
    .toArray();
  let max = ops.zero;
  let min = ops.zero;
  let total = ops.zero;

  for (let index = 0; index < statistics.length; index++) {
    if (index % 32 === 0) yield;
    const stat = statistics[index]!;
    if (ops.isGreaterThan(stat.value, max) || ops.equals(max, ops.zero)) max = stat.value;
    if (ops.isGreaterThan(min, stat.value) || ops.equals(min, ops.zero)) min = stat.value;
    total = ops.plus(total, stat.value);
  }
  return {
    statistics,
    currentValue: statistics.at(-1)?.value ?? ops.zero,
    totalValue: total,
    maxValue: max,
    minValue: min,
  };
}

/**
 * Which axis an exercise's progress is read on. Externally loaded, weight style exercises (squats)
 * return 'load'
 */
function primaryAxisFor(blueprint: ExerciseBlueprint): StatAxis {
  return blueprint.type === 'WeightedExerciseBlueprint' && blueprint.resistance === 'none' ? 'reps' : 'load';
}
