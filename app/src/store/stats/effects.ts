import {
  putStoredSession,
  updateStoredSession,
  deleteStoredSession,
  upsertStoredSessions,
  setActiveSessionId,
  setStoredSessions,
  selectSessionsBy,
} from '@/store/stored-sessions';
import {
  setOverallViewTime,
  setStatsIsDirty,
  fetchOverallStats,
  setOverallStats,
  warmAllTimeStats,
  GranularStatisticView,
} from './index';
import { LocalDate } from '@js-joda/core';
import { AddEffectFn, RootState } from '@/store/store';
import { Services } from '@/services';
import { sleep } from '@/utils/sleep';
import { RemoteData } from '@/models/remote';
import { selectPreferredWeightUnit, setUseImperialUnits } from '../settings';
import { calculateStatsAsync } from '@/store/stats/calculate-stats';
import { createWorkCheckpoint } from '@/utils/cooperative-work';

function snapshotKey(state: RootState) {
  return `${state.storedSessions.historyRevision}:${selectPreferredWeightUnit(state)}:${LocalDate.now().toString()}`;
}

function sameData(a: RootState, b: RootState) {
  return (
    a.storedSessions.historyRevision === b.storedSessions.historyRevision &&
    a.settings.useImperialUnits === b.settings.useImperialUnits
  );
}

export function applyStatsEffects(addEffect: AddEffectFn) {
  // Store-local, bounded to one result. Raw history is released after calculation, rather than
  // populating Redux and making every workout edit run whole-history selectors.
  let allTime: { key: string; result: Promise<GranularStatisticView>; promote: () => void } | undefined;
  let warmingEnabled = false;
  let displayedKey: string | undefined;

  function getAllTime(getState: () => RootState, services: Services, foreground = false) {
    const state = getState();
    const key = snapshotKey(state);
    if (allTime?.key === key) {
      if (foreground) allTime.promote();
      return allTime.result;
    }
    const checkpoint = createWorkCheckpoint(
      () => sameData(state, getState()),
      () => (foreground ? 16 : 4),
    );
    const result = (async () => {
      await checkpoint();
      const dates = state.storedSessions.isHydrated
        ? Object.values(state.storedSessions.sessions).map((session) => session.date)
        : (await services.sessionHistoryRepository.getActivitySummaries()).map((session) => session.date);

      // Include edits which may not have reached SQLite yet.
      dates.push(...Object.values(state.storedSessions.sessions).map((session) => session.date));
      const earliest = dates.reduce<LocalDate | undefined>(
        (first, date) => (!first || date.isBefore(first) ? date : first),
        undefined,
      );
      const timeframe = { from: earliest ?? LocalDate.now(), to: LocalDate.now() };
      const sessions = state.storedSessions.isHydrated
        ? selectSessionsBy(state, timeframe.from, timeframe.to)
        : await services.sessionHistoryRepository.getSessionsInRange(
            timeframe.from.toString(),
            timeframe.to.toString(),
            checkpoint,
          );
      await checkpoint();
      const merged = new Map(sessions.map((session) => [session.id, session]));
      for (const session of Object.values(getState().storedSessions.sessions)) {
        merged.delete(session.id);
        if (!session.date.isBefore(timeframe.from) && !session.date.isAfter(timeframe.to))
          merged.set(session.id, session);
      }
      if (state.storedSessions.activeSessionId) merged.delete(state.storedSessions.activeSessionId);

      const stats = await calculateStatsAsync(
        [...merged.values()],
        selectPreferredWeightUnit(state),
        timeframe,
        checkpoint,
      );

      await checkpoint();

      return stats;
    })();
    allTime = {
      key,
      result,
      promote: () => {
        foreground = true;
      },
    };
    // A failed or superseded job must never poison a later request with a cached rejection.
    void result.catch(() => {
      if (allTime?.result === result) allTime = undefined;
    });
    return result;
  }

  addEffect(warmAllTimeStats, async (_, { getState, cancelActiveListeners, signal, extra }) => {
    warmingEnabled = true;
    cancelActiveListeners();
    await sleep(3000);
    if (signal.aborted || !getState().storedSessions.isReady) return;
    const key = snapshotKey(getState());
    try {
      await getAllTime(getState, extra);
    } catch (error) {
      if (key === snapshotKey(getState())) extra.logger?.error('Failed to prepare statistics', error);
    }
  });

  addEffect(
    [
      putStoredSession,
      updateStoredSession,
      deleteStoredSession,
      upsertStoredSessions,
      setActiveSessionId,
      setStoredSessions,
      setUseImperialUnits,
    ],
    async (_, { dispatch, stateBeforeReduce, stateAfterReduce }) => {
      if (sameData(stateBeforeReduce, stateAfterReduce)) return;
      dispatch(setStatsIsDirty(true));
      if (warmingEnabled) dispatch(warmAllTimeStats());
    },
  );
  addEffect(fetchOverallStats, async (_, { getState, dispatch, cancelActiveListeners, signal, extra }) => {
    const state = getState();
    if (
      (!state.stats.isDirty && displayedKey === snapshotKey(state)) ||
      (!state.storedSessions.isReady && !state.storedSessions.isHydrated)
    )
      return;
    cancelActiveListeners();

    const key = snapshotKey(state);
    dispatch(setOverallStats(RemoteData.loading()));
    try {
      let stats: GranularStatisticView;
      if (state.stats.overallViewTime === 'all-time') {
        stats = await getAllTime(getState, extra, true);
      } else {
        await sleep(200);
        if (signal.aborted) return;
        const timeframe = state.stats.overallViewTime;
        const sessions = state.storedSessions.isHydrated
          ? selectSessionsBy(state, timeframe.from, timeframe.to)
          : await extra.sessionHistoryRepository.getSessionsInRange(timeframe.from.toString(), timeframe.to.toString());
        const checkpoint = createWorkCheckpoint(
          () => !signal.aborted && sameData(state, getState()),
          () => 16,
        );
        await checkpoint();
        const merged = new Map(sessions.map((session) => [session.id, session]));
        for (const session of Object.values(getState().storedSessions.sessions)) {
          merged.delete(session.id);
          if (!session.date.isBefore(timeframe.from) && !session.date.isAfter(timeframe.to))
            merged.set(session.id, session);
        }
        if (state.storedSessions.activeSessionId) merged.delete(state.storedSessions.activeSessionId);
        stats = await calculateStatsAsync(
          [...merged.values()],
          selectPreferredWeightUnit(state),
          timeframe,
          checkpoint,
        );
      }
      if (signal.aborted) return;
      if (snapshotKey(getState()) !== key) {
        dispatch(fetchOverallStats());
        return;
      }
      dispatch(setOverallStats(RemoteData.success(stats)));
      dispatch(setStatsIsDirty(false));
      displayedKey = key;
    } catch (error) {
      if (signal.aborted) return;
      if (snapshotKey(getState()) !== key) dispatch(fetchOverallStats());
      else dispatch(setOverallStats(RemoteData.error(error)));
    }
  });
  addEffect(setOverallViewTime, async (_, { dispatch }) => {
    dispatch(setStatsIsDirty(true));
    dispatch(fetchOverallStats());
  });
}
