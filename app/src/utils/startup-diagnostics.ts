import type { Logger } from '@/services/logger';
import type { ProfilerOnRenderCallback } from 'react';

const startedAt = performance.now();
const milestones = new Set<string>();
const pending: string[] = [];
let logger: Pick<Logger, 'info'> | undefined;

// One timeline per JS runtime. Fast Refresh is not a fresh launch; force-stop the app to measure boot.
export function markStartup(name: string, detail?: string) {
  if (milestones.has(name)) return;
  milestones.add(name);
  const now = performance.now();
  const message = `[startup] ${name}: +${(now - startedAt).toFixed(2)}ms (clock=${now.toFixed(2)}ms)${detail ? `; ${detail}` : ''}`;
  if (logger) logger.info(message);
  else pending.push(message);
}

export const logStartupRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  markStartup(`React ${id} ${phase}`, `render=${actualDuration.toFixed(2)}ms; base=${baseDuration.toFixed(2)}ms`);
};

export function attachStartupLogger(startupLogger: Pick<Logger, 'info'>) {
  logger = startupLogger;
  for (const message of pending.splice(0)) logger.info(message);
  logger.info(`[startup] mode=${__DEV__ ? 'development' : 'release'}; offsets are from diagnostics module evaluation`);
}

export function logNativeStartupTiming() {
  // Optional RN extension; absent on web and some native runtimes. Its timestamps share performance.now's origin.
  const timing = (
    performance as typeof performance & {
      rnStartupTiming?: {
        startTime?: number | null;
        initializeRuntimeStart?: number | null;
        executeJavaScriptBundleEntryPointStart?: number | null;
        endTime?: number | null;
      };
    }
  ).rnStartupTiming;
  const timestamps = {
    appStart: timing?.startTime ?? null,
    runtimeInit: timing?.initializeRuntimeStart ?? null,
    bundleEntry: timing?.executeJavaScriptBundleEntryPointStart ?? null,
    nativeEnd: timing?.endTime ?? null,
    clock: performance.now(),
  };
  logger?.info(`[startup] native timing: ${JSON.stringify(timestamps)}`);
}

markStartup('diagnostics loaded');
