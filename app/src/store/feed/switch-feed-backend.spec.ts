import { describe, it, expect, vi } from 'vitest';
import { createAddEffectTestBed } from '@/utils/__test__/add-effect-testbed';
import { applyFeedEffects } from '@/store/feed/effects';
import { clearFeedState, createFeedIdentity } from '@/store/feed';
import { setBackendAssignment, switchFeedBackend } from '@/store/backends';
import { FeedIdentity } from '@/models/feed-models';
import { RemoteData } from '@/models/remote';
import { ApiResult, ApiErrorType } from '@/services/api-error';

function makeIdentity(): FeedIdentity {
  return new FeedIdentity(
    'user-id',
    'lookup',
    { value: new Uint8Array([1]) },
    {
      publicKey: { spkiPublicKeyBytes: new Uint8Array([2]) },
      privateKey: { pkcs8PrivateKeyBytes: new Uint8Array([3]) },
    },
    'password',
    'Liam',
    true,
    true,
    true,
  );
}

function makeTestBed(identity: FeedIdentity | undefined, deleteResult = ApiResult.success()) {
  const feedIdentityService = { deleteFeedIdentityAsync: vi.fn().mockResolvedValue(deleteResult) };
  const testBed = createAddEffectTestBed({
    initialState: {
      feed: { identity: identity ? RemoteData.success(identity) : RemoteData.notAsked() },
    },
    services: { feedIdentityService, logger: { warn: vi.fn(), info: vi.fn() } },
  });
  applyFeedEffects(testBed.addEffect);
  return { testBed, feedIdentityService };
}

describe('switchFeedBackend', () => {
  it('deletes the account on the old server, wipes local feed data, then repoints', async () => {
    const identity = makeIdentity();
    const { testBed, feedIdentityService } = makeTestBed(identity);

    await testBed.dispatchHandled(switchFeedBackend({ backendId: 'self' }));

    expect(feedIdentityService.deleteFeedIdentityAsync).toHaveBeenCalledWith(identity);
    expect(testBed.dispatchedActions.map((x) => x.type)).toEqual([
      clearFeedState.type,
      setBackendAssignment.type,
      createFeedIdentity.type,
    ]);
    expect(testBed.getDispatchedAction(setBackendAssignment).payload).toEqual({
      feature: 'feed',
      backendId: 'self',
    });
  });

  // A server we can no longer reach must not strand the user on it.
  it('still switches when the old server cannot be reached', async () => {
    const { testBed } = makeTestBed(
      makeIdentity(),
      ApiResult.fromError({ type: ApiErrorType.Unknown, message: 'offline', exception: undefined }),
    );

    await testBed.dispatchHandled(switchFeedBackend({ backendId: 'self' }));

    expect(testBed.getDispatchedAction(setBackendAssignment).payload).toEqual({
      feature: 'feed',
      backendId: 'self',
    });
  });

  it('carries the profile onto the new account', async () => {
    const { testBed } = makeTestBed(makeIdentity());

    await testBed.dispatchHandled(switchFeedBackend({ backendId: 'self' }));

    expect(testBed.getDispatchedAction(createFeedIdentity).payload).toMatchObject({
      name: 'Liam',
      publishBodyweight: true,
      publishPlan: true,
      publishWorkouts: true,
    });
  });

  it('does not call the old server when there was no account', async () => {
    const { testBed, feedIdentityService } = makeTestBed(undefined);

    await testBed.dispatchHandled(switchFeedBackend({ backendId: 'self' }));

    expect(feedIdentityService.deleteFeedIdentityAsync).not.toHaveBeenCalled();
    expect(testBed.getDispatchedAction(setBackendAssignment)).toBeDefined();
  });
});
