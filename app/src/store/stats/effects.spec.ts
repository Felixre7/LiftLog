import { describe, it, expect, vi, afterEach } from 'vitest';
import { combineReducers } from '@reduxjs/toolkit';
import { LocalDate } from '@js-joda/core';
import { createAddEffectTestBed } from '@/utils/__test__/add-effect-testbed';
import { applyStatsEffects } from '@/store/stats/effects';
import { fetchOverallStats, setOverallViewTime, statsReducer, warmAllTimeStats } from '@/store/stats';
import { deleteStoredSession, storedSessionsReducer, updateStoredSession } from '@/store/stored-sessions';
import { makeSession, makeWeightedBlueprint } from '@/models/session-models/__test__/helpers';
import { RemoteData } from '@/models/remote';

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));

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
  afterEach(() => vi.useRealTimers());
  it('prepares all-time statistics without changing the visible range or hydrating Redux', async () => {
    vi.useFakeTimers();
    const { testBed, sessionHistoryRepository } = bed();
    const warming = testBed.dispatchHandled(warmAllTimeStats());
    expect(sessionHistoryRepository.getSessionsInRange).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await warming;
    expect(testBed.getState().stats.overallViewTime).not.toBe('all-time');
    expect(testBed.getState().storedSessions.sessions).toEqual({});
    testBed.dispatch(setOverallViewTime('all-time'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(1);
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
  });

  it('shares an in-flight warm-up and invalidates the result after a deletion', async () => {
    vi.useFakeTimers();
    const { testBed, sessionHistoryRepository } = bed();
    let finishRead!: (sessions: []) => void;
    sessionHistoryRepository.getSessionsInRange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const warming = testBed.dispatchHandled(warmAllTimeStats());
    await vi.advanceTimersByTimeAsync(3000);
    testBed.dispatch(setOverallViewTime('all-time'));
    const foreground = testBed.dispatchHandled(fetchOverallStats());
    finishRead([]);
    await vi.runAllTimersAsync();
    await Promise.all([warming, foreground]);
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(1);
    await testBed.dispatchHandled(deleteStoredSession('deleted'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(2);
  });

  it('discards a snapshot changed while reading and allows a fresh request', async () => {
    const { testBed, sessionHistoryRepository } = bed();
    let finishRead!: (sessions: []) => void;
    sessionHistoryRepository.getSessionsInRange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    testBed.dispatch(setOverallViewTime('all-time'));
    const foreground = testBed.dispatchHandled(fetchOverallStats());
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    await testBed.dispatchHandled(deleteStoredSession('deleted'));
    finishRead([]);
    await foreground;
    expect(testBed.getState().stats.isDirty).toBe(true);
    await testBed.dispatchHandled(fetchOverallStats());
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(2);
  });

  it('retries a failed warm-up and recomputes when the preferred unit changes', async () => {
    vi.useFakeTimers();
    const { testBed, sessionHistoryRepository } = bed();
    sessionHistoryRepository.getSessionsInRange.mockRejectedValueOnce(new Error('database unavailable'));
    const warming = testBed.dispatchHandled(warmAllTimeStats());
    await vi.runAllTimersAsync();
    await warming;
    testBed.dispatch(setOverallViewTime('all-time'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
    testBed.setState({ settings: { useImperialUnits: true } });
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(3);
    expect(testBed.getState().stats.overallView.isSuccess()).toBe(true);
  });

  it('keeps prepared history when an active workout changes', async () => {
    vi.useFakeTimers();
    const { testBed, sessionHistoryRepository, session } = bed();
    testBed.setState({
      storedSessions: {
        ...testBed.getState().storedSessions,
        activeSessionId: session.id,
        sessions: { [session.id]: session },
      },
    });
    const warming = testBed.dispatchHandled(warmAllTimeStats());
    await vi.runAllTimersAsync();
    await warming;
    const revision = testBed.getState().storedSessions.dataRevision;
    await testBed.dispatchHandled(
      updateStoredSession({ sessionId: session.id, update: (current) => current.with({ date: date.plusDays(1) }) }),
    );
    expect(testBed.getState().storedSessions.dataRevision).toBeGreaterThan(revision);
    testBed.dispatch(setOverallViewTime('all-time'));
    await testBed.dispatchHandled(fetchOverallStats());
    expect(sessionHistoryRepository.getSessionsInRange).toHaveBeenCalledTimes(1);
    expect(testBed.getState().stats.overallView.unwrapOr(undefined)?.workoutsPerWeek).toBe(0);
  });

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
      expect.any(Function),
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
