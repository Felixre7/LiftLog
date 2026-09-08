import { describe, it, expect, vi } from 'vitest';
import { combineReducers } from '@reduxjs/toolkit';
import { LocalDate } from '@js-joda/core';
import { createAddEffectTestBed } from '@/utils/__test__/add-effect-testbed';
import { applyStatsEffects } from '@/store/stats/effects';
import { fetchOverallStats, setOverallViewTime, statsReducer } from '@/store/stats';
import { deleteStoredSession, storedSessionsReducer } from '@/store/stored-sessions';
import { makeSession, makeWeightedBlueprint } from '@/models/session-models/__test__/helpers';
import { RemoteData } from '@/models/remote';

const date = LocalDate.of(2026, 4, 5);
function bed() {
  const session = makeSession([makeWeightedBlueprint()], date);
  const sessionHistoryRepository = {
    getSessionsInRange: vi.fn().mockResolvedValue([session]),
    getActivitySummaries: vi.fn().mockResolvedValue([{ date }]),
  };
  const testBed = createAddEffectTestBed({
    reducer: combineReducers({
      stats: statsReducer,
      storedSessions: storedSessionsReducer,
      settings: (state = { useImperialUnits: false }) => state,
    }),
    initialState: {
      storedSessions: { isReady: true, isHydrated: false },
      stats: { overallViewTime: { from: date.minusDays(30), to: date } },
    },
    services: { sessionHistoryRepository },
  });
  applyStatsEffects(testBed.addEffect);
  return { testBed, sessionHistoryRepository, session };
}

describe('selective statistics', () => {
  it('loads only the selected date range without hydrating history', async () => {
    const { testBed, sessionHistoryRepository } = bed();
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledWith('2026-03-06', '2026-04-05');
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
    expect(testBed.getState().storedSessions.isHydrated).toBe(false);
    expect(testBed.getState().storedSessions.sessions).toEqual({});
  });

  it('finds the all-time boundary from compact summaries', async () => {
    const { testBed, sessionHistoryRepository } = bed();
    testBed.dispatch(setOverallViewTime('all-time'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledWith(
      date.toString(),
      LocalDate.now().toString(),
    );
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
  });

  it('keeps failure retryable and marks cached statistics dirty after deletion', async () => {
    const { testBed, sessionHistoryRepository, session } = bed();
    sessionHistoryRepository.getSessionsInRange.mockRejectedValueOnce(new Error('read failed'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(
      testBed.getState().stats.overallView.match({ success: () => '', loading: () => '', error: (e) => String(e) }),
    ).toContain('read failed');
    await testBed.dispatchHandled(fetchOverallStats());
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
    expect(testBed.getState().stats.isDirty).toBe(false);
    await testBed.dispatchHandled(deleteStoredSession(session.id));
    expect(testBed.getState().stats.isDirty).toBe(true);
  });

  it('does not replace an in-memory active workout with its older database payload', async () => {
    const { testBed, session } = bed();
    testBed.setState({
      storedSessions: {
        ...testBed.getState().storedSessions,
        sessions: { [session.id]: session },
        activeSessionId: session.id,
      },
      stats: { ...testBed.getState().stats, overallView: RemoteData.notAsked() },
    });
    await testBed.dispatchHandled(fetchOverallStats());
    expect(testBed.getState().stats.overallView.unwrapOr(undefined)?.workoutsPerWeek).toBe(0);
  });
});
