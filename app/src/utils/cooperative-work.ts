import { AppState } from 'react-native';
import { sleep } from '@/utils/sleep';

export interface IdleWorkDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}
export type IdleTaskCallback = (deadline: IdleWorkDeadline) => void;

export type WorkCheckpoint = () => void | Promise<void>;

/** Bound CPU slices and stop optional work while the app is offscreen. */
export function createWorkCheckpoint(isCurrent: () => boolean, budgetMs = () => 4) {
  let sliceStarted = performance.now();
  const requestIdleTask = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: IdleTaskCallback) => unknown;
    }
  ).requestIdleCallback;
  let idleDeadline: IdleWorkDeadline | undefined;
  function checkCurrent() {
    if (!isCurrent()) throw new Error('Statistics snapshot superseded');
  }
  function isOffscreen() {
    return AppState?.currentState === 'background' || AppState?.currentState === 'inactive';
  }
  async function yieldWork() {
    if (typeof requestIdleTask === 'function') {
      await new Promise<void>((resolve) => {
        requestIdleTask((deadline) => {
          idleDeadline = deadline;
          resolve();
        });
      });
    } else {
      await sleep(0);
    }
    checkCurrent();
    while (isOffscreen()) {
      await sleep(250);
      checkCurrent();
    }
    sliceStarted = performance.now();
  }
  return () => {
    checkCurrent();
    if (
      isOffscreen() ||
      performance.now() - sliceStarted >= budgetMs() ||
      (typeof requestIdleTask === 'function' && (!idleDeadline || idleDeadline.timeRemaining() < 1))
    )
      return yieldWork();
  };
}
