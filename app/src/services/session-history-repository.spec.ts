import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { eq, sql } from 'drizzle-orm';
import { LocalDate, OffsetDateTime } from '@js-joda/core';
import { DatabaseMigrationService } from '@/services/database-migration-service';
import {
  SessionHistoryRepository,
  updateSessionSearch,
  withSessionTransaction,
} from '@/services/session-history-repository';
import { recordedExerciseIndexSchema, sessionsSchema } from '@/db/schema';
import { Logger } from '@/services/logger';
import {
  makeCardioBlueprint,
  makeRecordedExercise,
  makeSession,
  makeWeightedBlueprint,
} from '@/models/session-models/__test__/helpers';
import { RecordedCardioExercise, Session } from '@/models/session-models';
import { Weight } from '@/models/weight';
import { sessionVolume } from '@/store/activity/volume';
import { findPersonalRecords } from '@/store/stats/personal-records';
import { selectHistoryPersonalRecords, setActivitySummaries, storedSessionsReducer } from '@/store/stored-sessions';
import { RootState } from '@/store';

const blueprint = makeWeightedBlueprint();
const time = OffsetDateTime.parse('2026-04-05T10:00:00Z');
function workout(id: string, day: number, weight = 100, completed = true) {
  const exercise = makeRecordedExercise(
    blueprint,
    completed ? [10, 10, 10] : [undefined, undefined, undefined],
    new Weight(weight, 'kilograms'),
    () => time.plusDays(day),
  );
  return makeSession([blueprint], LocalDate.of(2026, 4, 5).plusDays(day)).with({ id, recordedExercises: [exercise] });
}
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
let db: ExpoSQLiteDatabase;
let repository: SessionHistoryRepository;
async function insert(values: Session[]) {
  await db.insert(sessionsSchema).values(values.map((session) => ({ id: session.id, payload: session.toJSON() })));
}

beforeEach(async () => {
  db = drizzle(await openDatabaseAsync(':memory:'));
  await new DatabaseMigrationService(db, logger, { importOldData: async () => {} }).migrate();
  repository = new SessionHistoryRepository(db, logger);
});

describe('indexed session history', () => {
  it('backfills search facts without modifying authoritative payloads or active flags', async () => {
    const session = workout('one', 0);
    await db.insert(sessionsSchema).values({ id: session.id, active: true, payload: session.toJSON() });
    const before = await Promise.resolve(
      db.get<{ payload: string }>(sql`SELECT payload FROM session WHERE id = 'one'`),
    );
    await Promise.all([repository.ensureIndexed(), repository.ensureIndexed()]);
    const [row] = await db.select().from(sessionsSchema);
    expect(row?.active).toBe(true);
    expect(row?.date).toBe('2026-04-05');
    expect(row?.searchVersion).toBe(1);
    expect(await db.get(sql`SELECT payload FROM session WHERE id = 'one'`)).toEqual(before);
    expect(await db.select().from(recordedExerciseIndexSchema)).toHaveLength(1);
    await repository.ensureIndexed();
    expect(await db.select().from(recordedExerciseIndexSchema)).toHaveLength(1);
  });

  it('selects the latest valid progression match and ignores abandoned sets and changed schemes', async () => {
    const latest = workout('valid', 1, 110);
    const otherBlueprint = makeWeightedBlueprint({ name: 'Other' });
    await insert([workout('old', 0), latest, workout('abandoned', 2, 120, false), makeSession([otherBlueprint])]);
    const result = await repository.getLatestExercises([blueprint.progressionKey(), otherBlueprint.progressionKey()]);
    expect(result[blueprint.progressionKey()]?.toJSON()).toEqual(latest.recordedExercises[0]?.toJSON());
    expect(result[otherBlueprint.progressionKey()]).toBeUndefined();
    expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('2 keys, 1 sessions'));
    await repository.getLatestExercises([blueprint.progressionKey(), otherBlueprint.progressionKey()]);
    expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('2 keys, 0 sessions'));
  });

  it('recovers a projection invalidated by a raw payload edit, including a cached missing result', async () => {
    const empty = workout('edit', 0, 100, false);
    await insert([empty]);
    expect(
      (await repository.getLatestExercises([blueprint.progressionKey()]))[blueprint.progressionKey()],
    ).toBeUndefined();
    const edited = workout('edit', 1, 125);
    await db.update(sessionsSchema).set({ payload: edited.toJSON() }).where(eq(sessionsSchema.id, edited.id));
    expect((await db.select().from(sessionsSchema))[0]?.searchVersion).toBeNull();
    const result = await repository.getLatestExercises([blueprint.progressionKey()]);
    expect(result[blueprint.progressionKey()]?.toJSON()).toEqual(edited.recordedExercises[0]?.toJSON());
  });

  it('rolls back payload and projection together when a write fails', async () => {
    const original = workout('edit', 0);
    await insert([original]);
    await repository.ensureIndexed();
    const edited = workout('edit', 1, 125);
    await expect(
      withSessionTransaction(db, async (tx) => {
        await tx.update(sessionsSchema).set({ payload: edited.toJSON() }).where(eq(sessionsSchema.id, edited.id));
        await updateSessionSearch(tx, edited);
        throw new Error('interrupted write');
      }),
    ).rejects.toThrow('interrupted write');
    expect((await repository.getSession('edit'))?.toJSON()).toEqual(original.toJSON());
    expect(
      (await repository.getLatestExercises([blueprint.progressionKey()]))[blueprint.progressionKey()]?.toJSON(),
    ).toEqual(original.recordedExercises[0]?.toJSON());
  });

  it('resumes a partially completed backfill', async () => {
    await insert([workout('a', 0), workout('b', 1)]);
    await withSessionTransaction(db, async (tx) => {
      await updateSessionSearch(tx, workout('a', 0));
    });
    await repository.ensureIndexed();
    expect((await db.select().from(sessionsSchema)).map((row) => row.searchVersion)).toEqual([1, 1]);
    expect(await db.select().from(recordedExerciseIndexSchema)).toHaveLength(2);
  });

  it('deletion removes lookup rows and invalidation exposes the preceding performance', async () => {
    await insert([workout('a', 0), workout('b', 1)]);
    await repository.getLatestExercises([blueprint.progressionKey()]);
    repository.invalidate();
    await db.delete(sessionsSchema).where(eq(sessionsSchema.id, 'b'));
    expect(await db.select().from(recordedExerciseIndexSchema)).toHaveLength(1);
    expect(
      (await repository.getLatestExercises([blueprint.progressionKey()]))[blueprint.progressionKey()]?.toJSON(),
    ).toEqual(workout('a', 0).recordedExercises[0]?.toJSON());
  });

  it('paginates tied exercise timestamps without duplicates or truncation', async () => {
    await insert(Array.from({ length: 57 }, (_, i) => workout(`session-${String(i).padStart(3, '0')}`, 0)));
    const first = await repository.getExerciseHistory(blueprint.movementKey());
    const second = await repository.getExerciseHistory(blueprint.movementKey(), first.next);
    const third = await repository.getExerciseHistory(blueprint.movementKey(), second.next);
    expect([first.exercises.length, second.exercises.length, third.exercises.length]).toEqual([25, 25, 7]);
    expect(first.next?.sessionId).toBe('session-024');
    expect(second.next?.sessionId).toBe('session-049');
    expect(third.next).toBeUndefined();
  });

  it('keeps weighted and cardio movements separate and excludes the viewed workout from previous values', async () => {
    const cardio = makeCardioBlueprint().with({ name: blueprint.name });
    const cardioSession = makeSession([cardio]).with({
      id: 'cardio',
      recordedExercises: [RecordedCardioExercise.empty(cardio)],
    });
    await insert([workout('a', 0), workout('active', 1), cardioSession]);
    expect((await repository.getExerciseHistory(cardio.movementKey())).exercises).toHaveLength(0);
    const context = await repository.getWorkoutContext([blueprint], 'active');
    expect(context[blueprint.movementKey()]?.[0]?.toJSON()).toEqual(workout('a', 0).recordedExercises[0]?.toJSON());
  });

  it('keeps the active workout out of exercise history and previous-value context', async () => {
    await insert([workout('older', 0), workout('active', 1)]);
    await db.update(sessionsSchema).set({ active: true }).where(eq(sessionsSchema.id, 'active'));
    expect((await repository.getExerciseHistory(blueprint.movementKey())).exercises).toHaveLength(1);
    const context = await repository.getWorkoutContext([blueprint], 'some-other-viewed-workout');
    expect(context[blueprint.movementKey()]?.[0]?.toJSON()).toEqual(workout('older', 0).recordedExercises[0]?.toJSON());
  });

  it('finds the previous comparable workout without accepting the active session or a same-second completion', async () => {
    const previous = workout('previous', 0);
    const active = workout('active', 1);
    const current = workout('current', 2);
    await insert([previous, active, current, current.with({ id: 'same-second' })]);
    expect((await repository.getPreviousComparableSession(current, active.id))?.id).toBe(previous.id);
  });

  it('uses the compound index for latest progression lookup', async () => {
    const plan = await Promise.resolve(
      db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT sessionId, exerciseIndex FROM recorded_exercise_index WHERE progressionKey = ${blueprint.progressionKey()} ORDER BY latestTime DESC, sessionId ASC, exerciseIndex ASC LIMIT 1`,
      ),
    );
    expect(plan.some((row) => row.detail.includes('exercise_progression_time_index'))).toBe(true);
    expect(plan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
  });

  it('queries only the selected month/range and preserves ordering and bodyweight context', async () => {
    const first = workout('april', 0).with({ bodyweight: new Weight(75, 'kilograms') });
    const next = workout('may', 30).with({ bodyweight: new Weight(76, 'kilograms') });
    await insert([first, next, Session.freeformSession(LocalDate.of(2026, 6, 1), undefined)]);
    expect((await repository.getSessionsByMonth('2026-04')).map((session) => session.id)).toEqual(['april']);
    expect((await repository.getSessionsInRange('2026-04-05', '2026-04-05')).map((session) => session.id)).toEqual([
      'april',
    ]);
    expect((await repository.getLatestPlannedSession())?.toJSON()).toEqual(next.toJSON());
    const page = await repository.getSessionPage(undefined, 2);
    expect(page).toHaveLength(2);
    const last = page.at(-1)!;
    const rest = await repository.getSessionPage(
      { id: last.id, referenceTime: time.plusDays(30).toInstant().toEpochMilli() },
      2,
    );
    expect(rest.map((session) => session.id)).toEqual(['april']);
  });

  it('compact summaries preserve volume and all-time personal records without hydrating sessions', async () => {
    const values = [workout('a', 0, 100), workout('b', 1, 110), workout('c', 2, 105)];
    await insert(values);
    const summaries = await repository.getActivitySummaries();
    expect(summaries.map((summary) => summary.volume)).toEqual(values.map(sessionVolume));
    const state = { storedSessions: storedSessionsReducer(undefined, setActivitySummaries(summaries)) } as RootState;
    expect(selectHistoryPersonalRecords(state)).toEqual(findPersonalRecords(values));
    expect(state.storedSessions.sessions).toEqual({});
  });

  it('queries a generated large history without reconstructing unrelated payloads after backfill', async () => {
    const extraBlueprints = Array.from({ length: 5 }, (_, i) => makeWeightedBlueprint({ name: `Other lift ${i}` }));
    const values = Array.from({ length: 2235 }, (_, i) => {
      const base = workout(`large-${i}`, i);
      return base.with({
        recordedExercises: [
          base.recordedExercises[0]!,
          ...extraBlueprints.map((exercise) =>
            makeRecordedExercise(exercise, [10, 10, 10], new Weight(100, 'kilograms'), () => time.plusDays(i)),
          ),
        ],
      });
    });
    for (let i = 0; i < values.length; i += 100) await insert(values.slice(i, i + 100));
    await repository.ensureIndexed();
    const reconstruct = vi.spyOn(Session, 'fromJSON');
    try {
      await repository.getLatestExercises([blueprint.progressionKey()]);
      expect(reconstruct).toHaveBeenCalledTimes(1);
      reconstruct.mockClear();
      await repository.getExerciseHistory(blueprint.movementKey());
      expect(reconstruct).toHaveBeenCalledTimes(25);
    } finally {
      reconstruct.mockRestore();
    }
  }, 30000);
});
