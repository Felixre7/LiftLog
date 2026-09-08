import { Remote } from '@/components/presentation/foundation/remote';
import { useServices } from '@/components/smart/services-provider';
import { RemoteData } from '@/models/remote';
import { useAppSelector } from '@/store';
import { setActivitySummaries } from '@/store/stored-sessions';
import { useIsFocused } from 'expo-router';
import { ReactNode, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';

/** The feed's own calendar needs all-history facts, but no historical workout payloads. */
export function SessionActivityGate({ children }: { children: ReactNode }) {
  const { sessionHistoryRepository } = useServices();
  const revision = useAppSelector((state) => state.storedSessions.dataRevision);
  const [load, setLoad] = useState<RemoteData<boolean>>(RemoteData.loading());
  const [retry, setRetry] = useState(0);
  const isFocused = useIsFocused();
  const dispatch = useDispatch();
  useEffect(() => {
    if (!isFocused) return;
    let cancelled = false;
    void sessionHistoryRepository
      .getActivitySummaries()
      .then((summaries) => {
        if (cancelled) return;
        dispatch(setActivitySummaries(summaries));
        setLoad(RemoteData.success(true));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad(RemoteData.error(String(error)));
      });
    return () => {
      cancelled = true;
    };
  }, [revision, retry, isFocused, sessionHistoryRepository, dispatch]);
  return <Remote value={load} retry={() => setRetry((value) => value + 1)} success={() => children} />;
}
