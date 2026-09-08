import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-purchases', () => ({
  default: { configure: vi.fn(), getCustomerInfo: vi.fn(), syncPurchases: vi.fn() },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import Purchases from 'react-native-purchases';
import { createAddEffectTestBed } from '@/utils/__test__/add-effect-testbed';
import { applySettingsEffects } from './effects';
import { initializeSettingsStateSlice, setIsHydrated } from '@/store/settings';
import { initializeStoredSessionsStateSlice } from '@/store/stored-sessions';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function startupTestBed() {
  vi.stubGlobal('__DEV__', false);
  const testBed = createAddEffectTestBed({
    services: {
      preferenceService: {
        getPreference: vi.fn().mockResolvedValue(undefined),
        getPreferredLanguage: vi.fn().mockReturnValue('en'),
        getLastSuccessfulRemoteBackupHash: vi.fn().mockResolvedValue(undefined),
        getLastBackupTime: vi.fn().mockResolvedValue(undefined),
        getLastBackupBackendId: vi.fn().mockResolvedValue(undefined),
        getProToken: vi.fn().mockResolvedValue('legacy-token'),
        setProToken: vi.fn().mockResolvedValue(undefined),
      },
      logger: { info: vi.fn(), log: vi.fn(), error: vi.fn() },
    },
  });
  applySettingsEffects(testBed.addEffect);
  return testBed;
}

describe('release settings startup', () => {
  it('finishes hydration without a purchase key and preserves the legacy token', async () => {
    vi.stubEnv('EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY', undefined);
    const bed = startupTestBed();
    await bed.dispatchHandled(initializeSettingsStateSlice());
    expect(bed.getDispatchedAction(setIsHydrated).payload).toBe(true);
    expect(bed.dispatchedActions).toContainEqual(initializeStoredSessionsStateSlice());
    expect(Purchases.configure).not.toHaveBeenCalled();
    expect(Purchases.getCustomerInfo).not.toHaveBeenCalled();
    expect(bed.mockServices.preferenceService.setProToken).not.toHaveBeenCalled();
  });

  it('finishes hydration when purchase configuration throws', async () => {
    vi.stubEnv('EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY', 'test-key');
    vi.mocked(Purchases.configure).mockImplementation(() => {
      throw new Error('Invalid API key');
    });
    const bed = startupTestBed();
    await bed.dispatchHandled(initializeSettingsStateSlice());
    expect(bed.getDispatchedAction(setIsHydrated).payload).toBe(true);
    expect(bed.mockServices.logger.error).toHaveBeenCalledWith(
      'Failed to configure purchases; continuing local startup',
      expect.any(Error),
    );
    expect(Purchases.getCustomerInfo).not.toHaveBeenCalled();
  });

  it('still migrates the legacy token when purchases are configured', async () => {
    vi.stubEnv('EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY', 'test-key');
    vi.mocked(Purchases.getCustomerInfo).mockResolvedValue({ originalAppUserId: '$RCAnonymousID:test' } as never);
    const bed = startupTestBed();
    await bed.dispatchHandled(initializeSettingsStateSlice());
    expect(Purchases.configure).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(Purchases.syncPurchases).toHaveBeenCalled();
    expect(bed.mockServices.preferenceService.setProToken).toHaveBeenCalledWith('$RCAnonymousID:test');
    expect(bed.getDispatchedAction(setIsHydrated).payload).toBe(true);
  });
});
