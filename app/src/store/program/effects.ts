import { BuiltInPrograms } from '@/models/built-in-programs';
import { RemoteData } from '@/models/remote';
import { ProgramBlueprint } from '@/models/blueprint-models';
import { AddEffectFn, RootState } from '@/store/store';
import {
  fetchUpcomingSessions,
  initializeProgramStateSlice,
  savePlan,
  selectActiveProgram,
  setActivePlan,
  setIsHydrated,
  setSavedPlans,
  setUpcomingSessions,
} from '@/store/program';
import { uuid } from '@/utils/uuid';
import { AsyncStream } from 'data-async-iterators';
import { Logger } from '@/services/logger';
import { selectLatestExercises } from '../stored-sessions';
import { programsSchema } from '@/db/schema';
import { toLocalDateJSON } from '@/models/storage/versions/latest';
import { programBlueprintMigrations } from '@/models/storage/versions/migrations';
import { LocalDate } from '@js-joda/core';
import { toRecord } from '@/utils/reduce';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { TaskAbortError } from '@reduxjs/toolkit';
import { markStartup } from '@/utils/startup-diagnostics';

const builtInProgramsStorageKey = 'hasSavedDefaultPlans2';
export function applyProgramEffects(addEffect: AddEffectFn) {
  let upcomingRequest: { inputs: readonly unknown[] } | undefined;
  addEffect(
    initializeProgramStateSlice,
    async (
      _,
      { getState, cancelActiveListeners, dispatch, extra: { keyValueStore, logger, db }, throwIfCancelled },
    ) => {
      const start = performance.now();
      cancelActiveListeners();

      let activePlanId: string | undefined;
      const dbPrograms = await db.select().from(programsSchema);
      const programs = (dbPrograms.length ? dbPrograms : [getEmptyInitialProgram()]).reduce(
        toRecord(
          (x) => x.id,
          (row) => {
            if (row.active) {
              activePlanId = row.id;
            }
            return ProgramBlueprint.fromJSON(programBlueprintMigrations.migrate(row.payload));
          },
        ),
        {},
      );
      dispatch(setSavedPlans(programs));

      if (!(await keyValueStore.getItem(builtInProgramsStorageKey))) {
        for (const [id, program] of Object.entries(BuiltInPrograms)) {
          if (id in getState().program.savedPrograms) {
            continue;
          }
          dispatch(savePlan({ programId: id, programBlueprint: program }));
        }
        await persistPrograms(getState(), db, logger, throwIfCancelled);
        await keyValueStore.setItem(builtInProgramsStorageKey, 'true');
      }
      if (!activePlanId || !getState().program.savedPrograms[activePlanId]) {
        activePlanId = Object.keys(getState().program.savedPrograms)[0]!;
      }

      dispatch(setActivePlan({ activePlanId }));

      dispatch(setIsHydrated(true));
      dispatch(fetchUpcomingSessions());
      const end = performance.now();
      logger.info(`initializeProgramStateSlice effect took ${(end - start).toFixed(2)} ms`);
    },
  );

  // Persist after changes
  addEffect(
    undefined,
    async (
      _,
      { stateBeforeReduce, stateAfterReduce, extra: { db, logger }, throwIfCancelled, cancelActiveListeners },
    ) => {
      cancelActiveListeners();
      const start = performance.now();
      const shouldPersist =
        stateAfterReduce.program.isHydrated &&
        (stateAfterReduce.program.activePlanId !== stateBeforeReduce.program.activePlanId ||
          stateAfterReduce.program.savedPrograms !== stateBeforeReduce.program.savedPrograms);
      if (shouldPersist) {
        await persistPrograms(stateAfterReduce, db, logger, throwIfCancelled);
        const end = performance.now();
        logger.info(`Persist program state effect took ${(end - start).toFixed(2)} ms`);
      }
    },
  );

  addEffect(
    fetchUpcomingSessions,
    async (
      _,
      {
        signal,
        cancelActiveListeners,
        dispatch,
        getState,
        extra: { sessionService, sessionHistoryRepository, logger },
      },
    ) => {
      const state = getState();
      if (!state.storedSessions.isReady && !state.storedSessions.isHydrated) return;
      const program = selectActiveProgram(state);
      if (!program) return;
      const sessionBlueprints = program.sessions;
      // Hydration and screen focus can request the same work while it is still running.
      // Compare every state input used by SessionService; edits must supersede the old request.
      const inputs = [
        sessionBlueprints,
        state.storedSessions.sessions,
        state.storedSessions.latestExercises,
        state.storedSessions.activeSessionId,
        state.settings.useImperialUnits,
      ];
      if (upcomingRequest?.inputs.every((input, index) => input === inputs[index])) {
        logger.info('fetchUpcomingSessions joined existing request');
        return;
      }

      const request = { inputs };
      upcomingRequest = request;
      const start = performance.now();
      cancelActiveListeners();
      try {
        markStartup('upcoming effect yield started');
        await yieldToEventLoop();
        markStartup('upcoming effect yield finished');
        if (signal.aborted) return;

        const latestExercises = state.storedSessions.isHydrated
          ? selectLatestExercises(state)
          : await sessionHistoryRepository.getLatestExercises(
              sessionBlueprints.flatMap((session) => session.exercises.map((exercise) => exercise.progressionKey())),
            );
        const latestSession = state.storedSessions.isHydrated
          ? undefined
          : ((await sessionHistoryRepository.getLatestPlannedSession()) ?? null);
        // Unsaved live edits take precedence over the database projection.
        if (!state.storedSessions.isHydrated) {
          for (const session of Object.values(getState().storedSessions.sessions)) {
            for (const exercise of session.recordedExercises) {
              const key = exercise.progressionKey();
              const previous = latestExercises[key];
              if (exercise.latestTime && (!previous?.latestTime || !exercise.latestTime.isBefore(previous.latestTime)))
                latestExercises[key] = exercise;
            }
          }
        }
        markStartup('upcoming latest exercises selected');
        const sessions = await AsyncStream.from(
          sessionService.getUpcomingSessions(sessionBlueprints, latestExercises, latestSession),
        )
          .takeWhile(() => !signal.aborted)
          .take(sessionBlueprints.length)
          .toArray();
        markStartup('upcoming generation finished');
        if (signal.aborted || upcomingRequest !== request) return;
        const current = getState();
        if (
          current.storedSessions.dataRevision !== state.storedSessions.dataRevision ||
          selectActiveProgram(current)?.sessions !== sessionBlueprints
        ) {
          upcomingRequest = undefined;
          dispatch(fetchUpcomingSessions());
          return;
        }
        dispatch(setUpcomingSessions(RemoteData.success(sessions)));
        markStartup('first upcoming workouts published');
        logger.info(`fetchUpcomingSessions effect took ${(performance.now() - start).toFixed(2)} ms`);
      } catch (error) {
        if (!signal.aborted && upcomingRequest === request) {
          logger.error('Failed to load upcoming workouts', error);
          dispatch(setUpcomingSessions(RemoteData.error(error instanceof Error ? error.message : String(error))));
        }
      } finally {
        if (upcomingRequest === request) upcomingRequest = undefined;
      }
    },
  );
}
// Helper function to yield control back to the event loop
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 5));

async function persistPrograms(
  stateAfterReduce: RootState,
  db: ExpoSQLiteDatabase,
  logger: Logger,
  throwIfCancelled: () => void,
) {
  try {
    await db.transaction(async (tx) => {
      throwIfCancelled();
      await tx.delete(programsSchema);
      await tx.insert(programsSchema).values(
        Object.entries(stateAfterReduce.program.savedPrograms).map(([key, program]) => ({
          id: key,
          active: key === stateAfterReduce.program.activePlanId,
          payload: program.toJSON(),
        })),
      );
      throwIfCancelled();
    });
  } catch (e) {
    if (e instanceof TaskAbortError) {
      return;
    }
    logger.error('Failed to persist program state', e);
  }
}

function getEmptyInitialProgram(): typeof programsSchema.$inferSelect {
  return {
    id: uuid(),
    active: true,
    payload: {
      version: 3,
      lastEdited: toLocalDateJSON(LocalDate.now()),
      name: 'My Plan',
      sessions: [],
    },
  };
}
