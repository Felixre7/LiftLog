import {
  copyLogs,
  initializeAppStateSlice,
  setCurrentSnackbar,
  setIsHydrated,
  shareString,
  showSnackbar,
} from '@/store/app';
import { AddEffectFn } from '@/store/store';
import { sleep } from '@/utils/sleep';
import { initializeSettingsStateSlice } from '../settings';
import { initializeProgramStateSlice } from '../program';
import { setStringAsync } from 'expo-clipboard';
import { initializeBackendsStateSlice } from '@/store/backends';
import { markStartup } from '@/utils/startup-diagnostics';

export function applyAppEffects(addEffect: AddEffectFn) {
  addEffect(
    initializeAppStateSlice,
    async (_, { cancelActiveListeners, dispatch, extra: { databaseMigrationService } }) => {
      cancelActiveListeners();
      markStartup('database migrations started');
      await databaseMigrationService.migrate();
      markStartup('database migrations finished');
      dispatch(initializeSettingsStateSlice());
      dispatch(initializeProgramStateSlice());
      dispatch(initializeBackendsStateSlice());
      dispatch(setIsHydrated(true));
    },
  );

  addEffect(showSnackbar, async (action, { dispatch, getState }) => {
    dispatch(setCurrentSnackbar(action.payload));
    await sleep(action.payload.duration ?? 5000);
    if (getState().app.currentSnackbar === action.payload) {
      dispatch(setCurrentSnackbar(undefined));
    }
  });

  addEffect(shareString, async (action, { extra: { stringSharer } }) => {
    await stringSharer.share(action.payload.value, action.payload.title);
  });

  addEffect(copyLogs, async (_, { extra: { logger } }) => {
    const logs = await logger.getLogsAsString();
    await setStringAsync(logs);
  });
}
