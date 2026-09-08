import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from 'react-native';
import { createWorkCheckpoint, type IdleTaskCallback } from './cooperative-work';

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));

describe('cooperative work', () => {
  afterEach(() => {
    AppState.currentState = 'active';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('yields to timers after the CPU budget is used', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const checkpoint = createWorkCheckpoint(() => true);
    now.mockReturnValue(5);
    let completed = false;
    const work = Promise.resolve(checkpoint()).then(() => {
      completed = true;
    });
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await work;
    expect(completed).toBe(true);
  });

  it('pauses in the background and rejects superseded work while paused', async () => {
    vi.useFakeTimers();
    AppState.currentState = 'background';
    let current = true;
    const checkpoint = createWorkCheckpoint(() => current);
    const work = Promise.resolve(checkpoint());
    const rejected = expect(work).rejects.toThrow('superseded');
    current = false;
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
  });

  it('uses native idle tasks and yields again when higher-priority work needs the runtime', async () => {
    const pending: IdleTaskCallback[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: IdleTaskCallback) => pending.push(callback));
    vi.spyOn(performance, 'now').mockReturnValue(0);
    let remaining = 50;
    const deadline = { didTimeout: false, timeRemaining: () => remaining };
    const checkpoint = createWorkCheckpoint(() => true);
    const first = checkpoint();
    expect(pending).toHaveLength(1);
    pending.shift()!(deadline);
    await first;
    expect(checkpoint()).toBeUndefined();
    remaining = 0;
    const yielded = checkpoint();
    expect(pending).toHaveLength(1);
    remaining = 50;
    pending.shift()!(deadline);
    await yielded;
    expect(checkpoint()).toBeUndefined();
  });

  it('rejects a stale job when its queued idle task finally runs', async () => {
    let resume!: IdleTaskCallback;
    vi.stubGlobal('requestIdleCallback', (callback: IdleTaskCallback) => {
      resume = callback;
    });
    let current = true;
    const checkpoint = createWorkCheckpoint(() => current);
    const work = checkpoint();
    const rejected = expect(work).rejects.toThrow('superseded');
    current = false;
    resume({ didTimeout: false, timeRemaining: () => 50 });
    await rejected;
  });
});
