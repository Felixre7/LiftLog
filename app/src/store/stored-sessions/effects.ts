import { updateSessionSearch, withSessionTransaction } from '@/services/session-history-repository';
import { AddEffectFn } from '@/store/store';
import {
  deleteExercise,
  deleteStoredSession,
  initializeStoredSessionsStateSlice,
  loadStoredSessionHistory,
  setHistoryLoad,
  setIsReady,
  putStoredSession,
  restoreExercise,
  selectSession,
  sessionFinished,
  setActiveSessionId,
  setBuiltInExercises,
  setExercises,
  setHiddenBuiltInIds,
  setIsHydrated,
  setStoredSessions,
  updateExercise,
  updateStoredSession,
  upsertExercises,
  upsertStoredSessions,
} from './index';
import { fetchUpcomingSessions } from '@/store/program';
import { addUnpublishedSessionId } from '@/store/feed';
import { setStatsIsDirty } from '@/store/stats';
import { setPreferredLanguage } from '@/store/settings';
import { Session } from '@/models/session-models';
import { sessionMigrations } from '@/models/storage/versions/migrations';
import { exercisesSchema, sessionsSchema } from '@/db/schema';
import { asc, eq, gt, sql } from 'drizzle-orm';
import { toRecord } from '@/utils/reduce';
import { fromExerciseDescriptorJSON, toExerciseDescriptorJSON } from '@/models/exercise-models';
import { loadBuiltInExercises } from '@/services/exercise-catalog';
import { migrateLegacyCurrentSession } from '@/store/stored-sessions/legacy-current-session';
import { markStartup } from '@/utils/startup-diagnostics';
import { RemoteData } from '@/models/remote';

// Built-ins the user deleted, so they stay hidden across restarts and locale switches.
const hiddenBuiltInExerciseIdsStorageKey = 'HiddenBuiltInExerciseIdList';
export function applyStoredSessionsEffects(addEffect: AddEffectFn) {
  const deletedBeforeHistoryLoaded = new Set<string>();
  addEffect(
    [putStoredSession, updateStoredSession, upsertStoredSessions, deleteStoredSession, setActiveSessionId],
    async (_, { extra: { sessionHistoryRepository } }) => {
      sessionHistoryRepository?.invalidate();
    },
  );
  // Dispatched AFTER settings, so we can safely access settings
  addEffect(
    initializeStoredSessionsStateSlice,
    async (_, { cancelActiveListeners, getState, dispatch, extra: { keyValueStore, db, logger } }) => {
      cancelActiveListeners();
      if (!getState().settings.isHydrated) {
        throw new Error('Settings must be hydrated before stored sessions');
      }
      const hydrateStoredSessionsStart = performance.now();
      markStartup('sessions loading started');
      await logger.time('initializeStoredSessions', async () => {
        const loadRowsStart = performance.now();
        const rows = await db.select().from(sessionsSchema).where(eq(sessionsSchema.active, true));
        logger.info(
          `loadStoredSessionRows completed in ${(performance.now() - loadRowsStart).toFixed(2)}ms (${rows.length} sessions)`,
        );

        const deserializeSessionsStart = performance.now();
        const storedSessions = rows.reduce(
          toRecord(
            (x) => x.id,
            (row) => Session.fromJSON(sessionMigrations.migrate(row.payload)),
          ),
          {},
        );
        logger.info(
          `deserializeStoredSessions completed in ${(performance.now() - deserializeSessionsStart).toFixed(2)}ms`,
        );

        const setStoredSessionsStart = performance.now();
        dispatch(setStoredSessions(storedSessions));
        logger.info(`setStoredSessions completed in ${(performance.now() - setStoredSessionsStart).toFixed(2)}ms`);
        // Only when there is one: dispatching `undefined` would clear every flag in the table, and a
        // kill between that write and the migration below would lose the workout in progress.
        const activeRowId = rows.find((x) => x.active)?.id;
        if (activeRowId) {
          dispatch(setActiveSessionId(activeRowId));
        }
      });

      await logger.time('migrateLegacyCurrentSession', () =>
        migrateLegacyCurrentSession(dispatch, getState, keyValueStore, logger),
      );

      const loadSavedExercisesStart = performance.now();
      const savedExercises = (await db.select().from(exercisesSchema)).reduce(
        toRecord(
          (x) => x.id,
          (x) => fromExerciseDescriptorJSON(x.payload),
        ),
        {},
      );
      dispatch(setExercises(savedExercises));
      logger.info(
        `loadSavedExercises completed in ${(performance.now() - loadSavedExercisesStart).toFixed(2)}ms (${Object.keys(savedExercises).length} exercises)`,
      );

      const loadBuiltInExercisesStart = performance.now();
      const builtInExercises = await loadBuiltInExercises(getState().settings.preferredLanguage);
      dispatch(setBuiltInExercises(builtInExercises));
      logger.info(
        `loadBuiltInExercises completed in ${(performance.now() - loadBuiltInExercisesStart).toFixed(2)}ms (${Object.keys(builtInExercises).length} exercises)`,
      );

      const loadHiddenBuiltInIdsStart = performance.now();
      const hiddenBuiltInIds = JSON.parse(
        (await keyValueStore.getItem(hiddenBuiltInExerciseIdsStorageKey)) ?? '[]',
      ) as string[];
      dispatch(setHiddenBuiltInIds(hiddenBuiltInIds));
      logger.info(
        `loadHiddenBuiltInExerciseIds completed in ${(performance.now() - loadHiddenBuiltInIdsStart).toFixed(2)}ms`,
      );

      logger.info(
        `hydrateStoredSessionsState completed in ${(performance.now() - hydrateStoredSessionsStart).toFixed(2)}ms`,
      );
      dispatch(setIsReady(true));
      markStartup('startup session data ready; completed history deferred');
      dispatch(fetchUpcomingSessions());
    },
  );

  addEffect(loadStoredSessionHistory, async (_, { getState, dispatch, extra: { db, logger } }) => {
    const state = getState().storedSessions;
    if (state.isHydrated) {
      logger.info(`loadCompletedSessionHistory reused cache (${Object.keys(state.sessions).length} sessions)`);
      return;
    }
    if (state.historyLoad.isLoading()) return;
    dispatch(setHistoryLoad(RemoteData.loading()));
    const start = performance.now();
    markStartup('completed history requested');
    try {
      // Let the existing loading indicator mount before starting the database work.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const sessions: Record<string, Session> = {};
      let count = 0;
      let afterId: string | undefined;
      while (true) {
        const rows = await db
          .select()
          .from(sessionsSchema)
          .where(afterId ? gt(sessionsSchema.id, afterId) : undefined)
          .orderBy(asc(sessionsSchema.id))
          .limit(25);
        for (const row of rows) {
          if (!deletedBeforeHistoryLoaded.has(row.id))
            sessions[row.id] = Session.fromJSON(sessionMigrations.migrate(row.payload));
        }
        count += rows.length;
        afterId = rows.at(-1)?.id ?? undefined;
        if (rows.length < 25) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // The live workout may have changed while SQLite was reading. In-memory edits win.
      for (const id of deletedBeforeHistoryLoaded) delete sessions[id];
      dispatch(setStoredSessions({ ...sessions, ...getState().storedSessions.sessions }));
      dispatch(setIsHydrated(true));
      deletedBeforeHistoryLoaded.clear();
      dispatch(setHistoryLoad(RemoteData.success(true)));
      logger.info(
        `loadCompletedSessionHistory completed in ${(performance.now() - start).toFixed(2)}ms (${count} sessions)`,
      );
      markStartup('completed history ready');
      dispatch(fetchUpcomingSessions());
    } catch (error) {
      logger.error('Failed to load session history', error);
      dispatch(setHistoryLoad(RemoteData.error(error instanceof Error ? error.message : String(error))));
    }
  });

  // Re-resolve the built-in catalog when the language changes (startup load is handled above).
  addEffect(setPreferredLanguage, async (action, { getState, dispatch }) => {
    if (!getState().storedSessions.isReady) {
      return;
    }
    dispatch(setBuiltInExercises(await loadBuiltInExercises(action.payload)));
  });

  // Completion, not content: a session is only exported and queued for the feed once the user is done
  // with it, otherwise every recorded set would fire a health export.
  addEffect(sessionFinished, async (action, { getState, dispatch, extra: { healthExportService, logger } }) => {
    const state = getState();
    const workout = selectSession(state, action.payload);
    if (!workout) {
      return;
    }

    if (state.storedSessions.activeSessionId === workout.id) {
      dispatch(setActiveSessionId(undefined));
    }
    dispatch(addUnpublishedSessionId(workout.id));
    dispatch(setStatsIsDirty(true));
    dispatch(fetchUpcomingSessions());

    if (!state.settings.exportToHealthAggregator || !healthExportService.canExport()) {
      return;
    }
    try {
      await healthExportService.exportWorkout(workout);
    } catch (e) {
      logger.error('Failed to sync to health aggregator', e);
    }
  });

  addEffect(deleteStoredSession, async (action, { getState, extra: { logger, db } }) => {
    // A read already in flight must not restore a workout the user just discarded.
    if (!getState().storedSessions.isHydrated) deletedBeforeHistoryLoaded.add(action.payload);
    await logger.time('deleteStoredSession', async () => {
      await withSessionTransaction(db, async (tx) => {
        await tx.delete(sessionsSchema).where(eq(sessionsSchema.id, action.payload));
      });
    });
  });
  addEffect(deleteStoredSession, async (action, { stateAfterReduce, extra: { healthExportService, logger } }) => {
    const workoutId = action.payload;
    if (!stateAfterReduce.settings.exportToHealthAggregator || !healthExportService.canExport()) {
      return;
    }
    try {
      await healthExportService.deleteWorkout(workoutId);
    } catch (e) {
      logger.error('Failed to delete workout from HealthConnect', e);
    }
  });

  // Content only. The `active` flag has a single writer below, so a recorded set never touches it.
  addEffect([putStoredSession, updateStoredSession], async (action, { getState, extra: { db, logger } }) => {
    const sessionId = putStoredSession.match(action)
      ? action.payload.id
      : updateStoredSession.match(action)
        ? action.payload.sessionId
        : undefined;
    // Read at write time rather than from stateAfterReduce, so a slow write still stores the newest
    // payload if a later edit overtakes it.
    const session = sessionId === undefined ? undefined : selectSession(getState(), sessionId);
    if (!session) {
      return;
    }
    await logger.time('persistStoredSession', async () => {
      await withSessionTransaction(db, async (tx) => {
        await tx
          .insert(sessionsSchema)
          .values({
            id: session.id,
            active: false,
            payload: session.toJSON(),
          })
          .onConflictDoUpdate({
            target: sessionsSchema.id,
            set: {
              payload: sql.raw(`excluded.${sessionsSchema.payload.name}`),
            },
          });
        await updateSessionSearch(tx, session);
      });
    });
  });

  // The only writer of `active`. It upserts rather than updates so it does not depend on the row having
  // been written by the effect above first - the two are dispatched together and race.
  addEffect(setActiveSessionId, async (action, { getState, extra: { db, logger } }) => {
    await logger.time('setActiveSessionId', async () => {
      await withSessionTransaction(db, async (tx) => {
        await tx.update(sessionsSchema).set({ active: false }).where(eq(sessionsSchema.active, true));
        const sessionId = action.payload;
        if (sessionId === undefined) {
          return;
        }
        const session = selectSession(getState(), sessionId);
        if (!session) {
          return;
        }
        await tx
          .insert(sessionsSchema)
          .values({ id: session.id, active: true, payload: session.toJSON() })
          .onConflictDoUpdate({ target: sessionsSchema.id, set: { active: true } });
        // On conflict the payload belongs to the content writer, so project that exact row.
        const [row] = await tx.select().from(sessionsSchema).where(eq(sessionsSchema.id, session.id));
        if (row) await updateSessionSearch(tx, Session.fromJSON(sessionMigrations.migrate(row.payload)));
      });
    });
  });

  addEffect(upsertStoredSessions, async (action, { cancelActiveListeners, extra: { db, logger } }) => {
    cancelActiveListeners();
    await logger.time('upsertStoredSessions', async () => {
      // Restored sessions are never active - a backup should not resume someone else's workout, and an
      // in-progress workout on this device keeps its flag because the conflict path only sets payload.
      const toUpsert = action.payload.map((x) => ({
        id: x.id,
        active: false,
        payload: x.toJSON(),
      }));
      if (!toUpsert.length) return;
      await withSessionTransaction(db, async (tx) => {
        for (let offset = 0; offset < toUpsert.length; offset += 100) {
          await tx
            .insert(sessionsSchema)
            .values(toUpsert.slice(offset, offset + 100))
            .onConflictDoUpdate({
              target: sessionsSchema.id,
              set: {
                payload: sql.raw(`excluded.${sessionsSchema.payload.name}`),
              },
            });
        }
        for (const session of action.payload) await updateSessionSearch(tx, session);
      });
    });
  });

  addEffect(deleteExercise, async (action, { stateAfterReduce, extra: { db, keyValueStore } }) => {
    if (stateAfterReduce.storedSessions.builtInExercises[action.payload]) {
      // Built-ins are tombstoned rather than removed; their override row (if any) is kept for undo.
      await keyValueStore.setItem(
        hiddenBuiltInExerciseIdsStorageKey,
        JSON.stringify(stateAfterReduce.storedSessions.hiddenBuiltInIds),
      );
    } else {
      await db.delete(exercisesSchema).where(eq(exercisesSchema.id, action.payload));
    }
  });

  addEffect(restoreExercise, async (_, { stateAfterReduce, extra: { keyValueStore } }) => {
    await keyValueStore.setItem(
      hiddenBuiltInExerciseIdsStorageKey,
      JSON.stringify(stateAfterReduce.storedSessions.hiddenBuiltInIds),
    );
  });

  addEffect(updateExercise, async (action, { extra: { db } }) => {
    await db
      .insert(exercisesSchema)
      .values({
        id: action.payload.id,
        payload: toExerciseDescriptorJSON(action.payload.exercise),
      })
      .onConflictDoUpdate({
        target: exercisesSchema.id,
        set: {
          payload: sql.raw(`excluded.${exercisesSchema.payload.name}`),
        },
      });
  });

  addEffect(upsertExercises, async (action, { extra: { db } }) => {
    const exercises = Object.entries(action.payload).map(([id, exercise]) => ({
      id,
      payload: toExerciseDescriptorJSON(exercise),
    }));
    if (!exercises.length) {
      return;
    }
    await db
      .insert(exercisesSchema)
      .values(exercises)
      .onConflictDoUpdate({
        target: exercisesSchema.id,
        set: {
          payload: sql.raw(`excluded.${exercisesSchema.payload.name}`),
        },
      });
  });

  addEffect(setExercises, async (action, { stateAfterReduce, extra: { db } }) => {
    if (!stateAfterReduce.storedSessions.isHydrated) {
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(exercisesSchema);
      await tx.insert(exercisesSchema).values(
        Object.entries(action.payload).map(([id, exercise]) => ({
          id,
          payload: toExerciseDescriptorJSON(exercise),
        })),
      );
    });
  });
}
