import { Remote } from '@/components/presentation/foundation/remote';
import { useServices } from '@/components/smart/services-provider';
import { RemoteData } from '@/models/remote';
import { useAppSelectorWithArg } from '@/store';
import { mergeLoadedSessions, selectSession } from '@/store/stored-sessions';
import { ReactNode, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';

/** A direct link to an older workout needs one payload, even before History has been visited. */
export function StoredSessionGate({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const session = useAppSelectorWithArg(selectSession, sessionId);
  const { sessionHistoryRepository } = useServices();
  const [load, setLoad] = useState<RemoteData<boolean>>(RemoteData.loading());
  const [retry, setRetry] = useState(0);
  const dispatch = useDispatch();
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    setLoad(RemoteData.loading());
    void sessionHistoryRepository
      .getSession(sessionId)
      .then((value) => {
        if (cancelled) return;
        if (value) dispatch(mergeLoadedSessions([value]));
        setLoad(RemoteData.success(true));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad(RemoteData.error(String(error)));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, session, retry, dispatch, sessionHistoryRepository]);
  return session ? (
    children
  ) : (
    <Remote value={load} retry={() => setRetry((value) => value + 1)} success={() => children} />
  );
}
