import { Remote } from '@/components/presentation/foundation/remote';
import { useAppSelector } from '@/store';
import { loadStoredSessionHistory } from '@/store/stored-sessions';
import { useIsFocused } from 'expo-router';
import { ReactNode, useEffect } from 'react';
import { useDispatch } from 'react-redux';

/** Offscreen routes must not request history just because native tabs mounted them. */
export function SessionHistoryGate({ children }: { children: ReactNode }) {
  const isFocused = useIsFocused();
  const isHydrated = useAppSelector((s) => s.storedSessions.isHydrated);
  const load = useAppSelector((s) => s.storedSessions.historyLoad);
  const dispatch = useDispatch();
  useEffect(() => {
    if (isFocused && !isHydrated) dispatch(loadStoredSessionHistory());
  }, [isFocused, isHydrated, dispatch]);

  return isHydrated ? (
    children
  ) : (
    <Remote value={load} retry={() => dispatch(loadStoredSessionHistory())} success={() => children} />
  );
}
