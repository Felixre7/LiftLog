import {
  putStoredSession,
  updateStoredSession,
  deleteStoredSession,
  upsertStoredSessions,
} from '@/store/stored-sessions';
import { setOverallViewTime, setStatsIsDirty } from './index';
import { LocalDate } from '@js-joda/core';
import { fetchOverallStats, setOverallStats } from './index';
import { AddEffectFn } from '@/store/store';
import { selectSessionsBy } from '@/store/stored-sessions';

import { sleep } from '@/utils/sleep';
import { RemoteData } from '@/models/remote';
import { selectPreferredWeightUnit } from '../settings';
import { calculateStats } from '@/store/stats/calculate-stats';

export function applyStatsEffects(addEffect: AddEffectFn) {
  addEffect(
    [putStoredSession, updateStoredSession, deleteStoredSession, upsertStoredSessions],
    async (_, { dispatch }) => {
      dispatch(setStatsIsDirty(true));
    },
  );
  addEffect(
    fetchOverallStats,
    async (_, { getState, dispatch, cancelActiveListeners, signal, extra: { sessionHistoryRepository, logger } }) => {
      const state = getState();

      if (!state.stats.isDirty || (!state.storedSessions.isReady && !state.storedSessions.isHydrated)) {
        return;
      }

      cancelActiveListeners();
      dispatch(setOverallStats(RemoteData.loading()));
      const started = performance.now();
      await sleep(200);
      try {
        let timeframe = state.stats.overallViewTime;
        if (timeframe === 'all-time') {
          const earliest = state.storedSessions.isHydrated
            ? state.storedSessions.earliestSession?.date
            : (await sessionHistoryRepository.getActivitySummaries())
                .map((session) => session.date)
                .sort((a, b) => a.compareTo(b))[0];
          if (!earliest) {
            if (!signal.aborted) dispatch(setOverallStats(RemoteData.error('No sessions')));
            return;
          }
          timeframe = { from: earliest, to: LocalDate.now() };
        }
        const sessions = state.storedSessions.isHydrated
          ? selectSessionsBy(state, timeframe.from, timeframe.to)
          : await sessionHistoryRepository.getSessionsInRange(timeframe.from.toString(), timeframe.to.toString());
        if (signal.aborted) return;
        const current = getState();
        if (current.storedSessions.dataRevision !== state.storedSessions.dataRevision) {
          dispatch(fetchOverallStats());
          return;
        }
        const merged = new Map(sessions.map((session) => [session.id, session]));
        for (const session of Object.values(current.storedSessions.sessions)) {
          merged.delete(session.id);
          if (!session.date.isBefore(timeframe.from) && !session.date.isAfter(timeframe.to))
            merged.set(session.id, session);
        }
        if (current.storedSessions.activeSessionId) merged.delete(current.storedSessions.activeSessionId);
        const stats = calculateStats([...merged.values()], selectPreferredWeightUnit(state), timeframe);
        dispatch(setOverallStats(RemoteData.success(stats)));
        dispatch(setStatsIsDirty(false));
        logger?.info(
          `queryOverallStats completed in ${(performance.now() - started).toFixed(2)}ms (${merged.size} sessions)`,
        );
      } catch (e) {
        if (!signal.aborted) dispatch(setOverallStats(RemoteData.error(e)));
      }
    },
  );

  addEffect(setOverallViewTime, async (_, { dispatch }) => {
    dispatch(setStatsIsDirty(true));
    dispatch(fetchOverallStats());
  });
}
