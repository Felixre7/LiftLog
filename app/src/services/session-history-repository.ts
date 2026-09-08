import { LocalDate } from '@js-joda/core';
import { Weight } from '@/models/weight';
import { SessionActivitySummary } from '@/models/session-summary';
import { sessionVolume } from '@/store/activity/volume';
import { bestOneRepMax } from '@/store/stats/personal-records';
import { recordedExerciseIndexSchema as exercises, sessionsSchema as sessions } from '@/db/schema';
import { ExerciseBlueprint, MovementKey, ProgressionKey } from '@/models/blueprint-models';
import { RecordedExercise, Session } from '@/models/session-models';
import { sessionMigrations } from '@/models/storage/versions/migrations';
import { getSessionReferenceTime } from '@/store/stored-sessions';
import { and, asc, desc, eq, gte, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import type { WorkCheckpoint } from '@/utils/cooperative-work';

const batchSize = 25;
const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const transactions = new WeakMap<ExpoSQLiteDatabase, Promise<unknown>>();

// Expo Drizzle's transaction(callback) commits synchronously; it does not await async callbacks.
// Keep the transaction open through the awaited operations, and serialize session writes/backfill.
// Operations inside this queue must only await database work, never timers or network requests.
export function withSessionTransaction<T>(
  db: ExpoSQLiteDatabase,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const previous = transactions.get(db) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await Promise.resolve(db.run(sql`BEGIN IMMEDIATE`));
      try {
        const result = await operation(db);
        await Promise.resolve(db.run(sql`COMMIT`));
        return result;
      } catch (error) {
        await Promise.resolve(db.run(sql`ROLLBACK`));
        throw error;
      }
    });
  transactions.set(
    db,
    next.catch(() => {}),
  );
  return next;
}

type Transaction = Pick<ExpoSQLiteDatabase, 'insert' | 'update' | 'delete' | 'select'>;

/** Rebuilt from model semantics, never from a second interpretation of historical JSON versions. */
export async function updateSessionSearch(tx: Transaction, session: Session) {
  await tx.delete(exercises).where(eq(exercises.sessionId, session.id));
  const rows = session.recordedExercises.flatMap((exercise, exerciseIndex) => {
    const time = exercise.latestTime;
    return time
      ? [
          {
            sessionId: session.id,
            exerciseIndex,
            movementKey: exercise.movementKey(),
            progressionKey: exercise.progressionKey(),
            latestTime: time.toInstant().toEpochMilli(),
          },
        ]
      : [];
  });
  // Avoid SQLite's bound-parameter limit for unusually large imported workouts.
  for (let offset = 0; offset < rows.length; offset += 100) {
    await tx.insert(exercises).values(rows.slice(offset, offset + 100));
  }
  await tx
    .update(sessions)
    .set({
      date: session.date.toString(),
      referenceTime: getSessionReferenceTime(session).toInstant().toEpochMilli(),
      workoutName: session.blueprint.name,
      searchVersion: 1,
      activity: {
        isStarted: session.isStarted,
        volume: sessionVolume(session),
        bests: [...bestOneRepMax(session)].map(([key, best]) => ({
          key,
          exerciseName: best.exerciseName,
          oneRepMax: best.oneRepMax.toJSON(),
        })),
      },
    })
    .where(eq(sessions.id, session.id));
}

export interface ExerciseHistoryCursor {
  latestTime: number;
  sessionId: string;
  exerciseIndex: number;
}
export interface SessionCursor {
  referenceTime: number;
  id: string;
}

/** JSON remains authoritative. Only matching payloads cross the SQLite/JS boundary. */
export class SessionHistoryRepository {
  private indexing: Promise<void> | undefined;
  private latestCache = new Map<ProgressionKey, RecordedExercise | undefined>();
  private revision = 0;

  invalidate() {
    this.revision++;
    this.latestCache.clear();
  }

  constructor(private db: ExpoSQLiteDatabase) {}

  ensureIndexed(): Promise<void> {
    if (!this.indexing) {
      this.indexing = this.backfill().finally(() => {
        this.indexing = undefined;
      });
    }
    return this.indexing;
  }

  private async backfill() {
    let count = 0;
    while (true) {
      // Each batch is atomic. A crash leaves the remaining rows marked unindexed for retry.
      const loaded = await withSessionTransaction(this.db, async (tx) => {
        const rows = await tx.select().from(sessions).where(isNull(sessions.searchVersion)).limit(batchSize);
        for (const row of rows) {
          await updateSessionSearch(tx, Session.fromJSON(sessionMigrations.migrate(row.payload)));
        }
        return rows.length;
      });
      count += loaded;
      if (loaded < batchSize) break;
      await yieldToUI();
    }
    if (count) this.latestCache.clear();
  }

  async getSessionIds(): Promise<string[]> {
    await transactions.get(this.db);
    return (await this.db.select({ id: sessions.id }).from(sessions)).flatMap((row) => (row.id ? [row.id] : []));
  }

  async getSession(id: string): Promise<Session | undefined> {
    await transactions.get(this.db);
    const [row] = await this.db.select({ payload: sessions.payload }).from(sessions).where(eq(sessions.id, id));
    return row ? Session.fromJSON(sessionMigrations.migrate(row.payload)) : undefined;
  }

  async getLatestPlannedSession(): Promise<Session | undefined> {
    await this.ensureIndexed();
    const [row] = await this.db
      .select({ payload: sessions.payload })
      .from(sessions)
      .where(ne(sessions.workoutName, 'Freeform Workout'))
      .orderBy(desc(sessions.referenceTime), asc(sessions.id))
      .limit(1);
    return row ? Session.fromJSON(sessionMigrations.migrate(row.payload)) : undefined;
  }

  async getLatestExercises(keys: ProgressionKey[]): Promise<Record<ProgressionKey, RecordedExercise | undefined>> {
    const revision = this.revision;
    await this.ensureIndexed();
    const result: Record<ProgressionKey, RecordedExercise | undefined> = {};
    const payloads = new Map<string, Session | undefined>();
    for (const key of new Set(keys)) {
      if (this.latestCache.has(key)) {
        result[key] = this.latestCache.get(key);
        continue;
      }
      const [match] = await this.db
        .select()
        .from(exercises)
        .where(eq(exercises.progressionKey, key))
        .orderBy(desc(exercises.latestTime), asc(exercises.sessionId), asc(exercises.exerciseIndex))
        .limit(1);
      if (match && !payloads.has(match.sessionId))
        payloads.set(match.sessionId, await this.getSession(match.sessionId));
      result[key] = match ? payloads.get(match.sessionId)?.recordedExercises[match.exerciseIndex] : undefined;
      if (revision === this.revision) this.latestCache.set(key, result[key]);
    }

    return result;
  }

  async getPreviousComparableSession(session: Session, activeSessionId?: string): Promise<Session | undefined> {
    await this.ensureIndexed();
    const [row] = await this.db
      .select({ payload: sessions.payload })
      .from(sessions)
      .where(
        and(
          eq(sessions.workoutName, session.blueprint.name),
          ne(sessions.id, session.id),
          activeSessionId ? ne(sessions.id, activeSessionId) : undefined,
          // The existing comparison intentionally excludes completions in the same second.
          lt(sessions.referenceTime, getSessionReferenceTime(session).toEpochSecond() * 1000),
        ),
      )
      .orderBy(desc(sessions.referenceTime), asc(sessions.id))
      .limit(1);
    return row ? Session.fromJSON(sessionMigrations.migrate(row.payload)) : undefined;
  }

  async getWorkoutContext(blueprints: ExerciseBlueprint[], excludeSessionId: string) {
    await this.ensureIndexed();
    const matches = new Map<string, typeof exercises.$inferSelect>();
    for (const blueprint of blueprints) {
      for (const condition of [
        eq(exercises.movementKey, blueprint.movementKey()),
        eq(exercises.progressionKey, blueprint.progressionKey()),
      ]) {
        const [row] = await this.db
          .select()
          .from(exercises)
          .where(
            and(
              condition,
              ne(exercises.sessionId, excludeSessionId),
              notInArray(
                exercises.sessionId,
                this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.active, true)),
              ),
            ),
          )
          .orderBy(desc(exercises.latestTime), asc(exercises.sessionId), asc(exercises.exerciseIndex))
          .limit(1);
        if (row) matches.set(`${row.sessionId}:${row.exerciseIndex}`, row);
      }
    }
    const models = new Map<string, Session | undefined>();
    const result: Record<MovementKey, RecordedExercise[]> = {};
    for (const row of [...matches.values()].sort((a, b) => b.latestTime - a.latestTime)) {
      if (!models.has(row.sessionId)) models.set(row.sessionId, await this.getSession(row.sessionId));
      const exercise = models.get(row.sessionId)?.recordedExercises[row.exerciseIndex];
      if (exercise) (result[exercise.movementKey()] ??= []).push(exercise);
    }
    return result;
  }

  async getActivitySummaries(): Promise<SessionActivitySummary[]> {
    await this.ensureIndexed();
    const rows = await this.db
      .select({
        id: sessions.id,
        date: sessions.date,
        referenceTime: sessions.referenceTime,
        activity: sessions.activity,
      })
      .from(sessions);
    return rows.map((row) => {
      if (!row.date || row.referenceTime === null || !row.activity)
        throw new Error('Session search backfill is incomplete');
      return {
        id: row.id,
        date: LocalDate.parse(row.date),
        referenceTime: row.referenceTime,
        ...row.activity,
        bests: row.activity.bests.map((best) => ({ ...best, oneRepMax: Weight.fromJSON(best.oneRepMax) })),
      };
    });
  }

  async getSessionsByMonth(month: string): Promise<Session[]> {
    await this.ensureIndexed();
    return this.readSessions(and(gt(sessions.date, `${month}-00`), lt(sessions.date, `${month}-32`)));
  }

  async getSessionPage(cursor?: SessionCursor, limit = batchSize): Promise<Session[]> {
    await this.ensureIndexed();
    const rows = await this.db
      .select({ payload: sessions.payload })
      .from(sessions)
      .where(
        cursor
          ? or(
              lt(sessions.referenceTime, cursor.referenceTime),
              and(eq(sessions.referenceTime, cursor.referenceTime), gt(sessions.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(desc(sessions.referenceTime), asc(sessions.id))
      .limit(limit);
    return rows.map((row) => Session.fromJSON(sessionMigrations.migrate(row.payload)));
  }

  async getSessionsInRange(from: string, to: string, checkpoint?: WorkCheckpoint): Promise<Session[]> {
    await this.ensureIndexed();
    return this.readSessions(and(gte(sessions.date, from), lte(sessions.date, to)), checkpoint);
  }

  private async readSessions(where: ReturnType<typeof and>, checkpoint?: WorkCheckpoint): Promise<Session[]> {
    const result: Session[] = [];
    let afterId: string | undefined;
    while (true) {
      const pause = checkpoint?.();
      if (pause) await pause;
      const rows = await this.db
        .select({ id: sessions.id, payload: sessions.payload })
        .from(sessions)
        .where(and(where, afterId ? gt(sessions.id, afterId) : undefined))
        .orderBy(asc(sessions.id))
        .limit(batchSize);
      for (const row of rows) {
        const pause = checkpoint?.();
        if (pause) await pause;
        result.push(Session.fromJSON(sessionMigrations.migrate(row.payload)));
      }

      if (rows.length < batchSize) return result;
      afterId = rows.at(-1)?.id ?? undefined;
      await yieldToUI();
    }
  }

  async getExerciseHistory(key: MovementKey, cursor?: ExerciseHistoryCursor, limit = batchSize) {
    await this.ensureIndexed();
    const rows = await this.db
      .select()
      .from(exercises)
      .where(
        and(
          eq(exercises.movementKey, key),
          notInArray(
            exercises.sessionId,
            this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.active, true)),
          ),
          cursor
            ? or(
                lt(exercises.latestTime, cursor.latestTime),
                and(eq(exercises.latestTime, cursor.latestTime), gt(exercises.sessionId, cursor.sessionId)),
                and(
                  eq(exercises.latestTime, cursor.latestTime),
                  eq(exercises.sessionId, cursor.sessionId),
                  gt(exercises.exerciseIndex, cursor.exerciseIndex),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(exercises.latestTime), asc(exercises.sessionId), asc(exercises.exerciseIndex))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const ids = [...new Set(page.map((row) => row.sessionId))];
    const payloads = ids.length
      ? await this.db
          .select({ id: sessions.id, payload: sessions.payload })
          .from(sessions)
          .where(inArray(sessions.id, ids))
      : [];
    const models = new Map(payloads.map((row) => [row.id, Session.fromJSON(sessionMigrations.migrate(row.payload))]));
    return {
      exercises: page.flatMap((row) => {
        const exercise = models.get(row.sessionId)?.recordedExercises[row.exerciseIndex];
        return exercise ? [exercise] : [];
      }),
      next: rows.length > limit ? page.at(-1) : undefined,
    };
  }
}
