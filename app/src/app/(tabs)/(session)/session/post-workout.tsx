import FullHeightScrollView from '@/components/layout/full-height-scroll-view';
import { PageActions } from '@/components/presentation/foundation/page-actions';
import CheckIcon from '@expo/material-symbols/check.xml';
import { SessionComparisonTable } from '@/components/presentation/workout/session-comparison-table';
import { spacing } from '@/hooks/useAppTheme';
import { useAppSelector, useAppSelectorWithArg } from '@/store';
import { useFinishWorkout } from '@/hooks/useFinishWorkout';
import { selectSession } from '@/store/stored-sessions';
import { useTranslate } from '@tolgee/react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StoredSessionGate } from '@/components/smart/stored-session-gate';
import { useServices } from '@/components/smart/services-provider';
import { Remote } from '@/components/presentation/foundation/remote';
import { RemoteData } from '@/models/remote';
import { Session } from '@/models/session-models';

export default function PostWorkoutPage() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return (
    <StoredSessionGate sessionId={sessionId}>
      <PostWorkoutComparison />
    </StoredSessionGate>
  );
}

function PostWorkoutComparison() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const session = useAppSelectorWithArg(selectSession, sessionId);
  const activeSessionId = useAppSelector((state) => state.storedSessions.activeSessionId);
  const { sessionHistoryRepository } = useServices();
  const [load, setLoad] = useState<RemoteData<Session | undefined>>(RemoteData.loading());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoad(RemoteData.loading());
    void sessionHistoryRepository
      .getPreviousComparableSession(session, activeSessionId)
      .then((previous) => {
        if (!cancelled) setLoad(RemoteData.success(previous));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad(RemoteData.error(String(error)));
      });
    return () => {
      cancelled = true;
    };
  }, [session, activeSessionId, sessionHistoryRepository, retry]);
  return (
    <Remote
      value={load}
      retry={() => setRetry((value) => value + 1)}
      success={(previous) => <PostWorkoutContent previousComparableSession={previous} />}
    />
  );
}

function PostWorkoutContent({ previousComparableSession }: { previousComparableSession: Session | undefined }) {
  const { sessionId, source } = useLocalSearchParams<{
    sessionId?: string;
    source?: 'finished' | 'live' | 'history';
  }>();
  const session = useAppSelectorWithArg(selectSession, sessionId ?? '');
  const openedAfterFinishingWorkout = source === 'finished';
  const showFinishButton = openedAfterFinishingWorkout;
  const showBackButton = !openedAfterFinishingWorkout;
  const { dismissTo, push } = useRouter();
  const finishWorkout = useFinishWorkout(sessionId);
  const { t } = useTranslate();

  useEffect(() => {
    if (!sessionId || !session) {
      dismissTo('/session');
    }
  }, [dismissTo, session, sessionId]);

  if (!sessionId || !session) {
    return null;
  }

  const floatingBottomContainer = showFinishButton ? (
    <PageActions
      primaryKind="commit"
      primary={{
        label: t('generic.finish.button'),
        icon: CheckIcon,
        systemImage: 'checkmark',
        onPress: () => {
          const hasDiff = finishWorkout();
          dismissTo('/');
          if (hasDiff) {
            push('/diff-save');
          }
        },
      }}
    />
  ) : undefined;

  return (
    <FullHeightScrollView
      floatingChildren={floatingBottomContainer}
      scrollStyle={{ paddingHorizontal: spacing.pageHorizontalMargin }}
    >
      <Stack.Screen
        options={{
          presentation: 'modal',
          title: t('workout.post_workout.title'),
          gestureEnabled: showBackButton,
          headerBackVisible: showBackButton,
          headerLeft: showFinishButton ? () => null : undefined!,
        }}
      />
      <View style={{ marginVertical: spacing[4] }}>
        <SessionComparisonTable mode="full" previousSession={previousComparableSession} session={session} />
      </View>
    </FullHeightScrollView>
  );
}
