import { SurfaceText } from '@/components/presentation/foundation/surface-text';
import { ExerciseHistoryList } from '@/components/presentation/workout/exercise-history-list';
import { spacing } from '@/hooks/useAppTheme';
import { ExerciseBlueprint, MovementKey } from '@/models/blueprint-models';
import { useServices } from '@/components/smart/services-provider';
import { Remote } from '@/components/presentation/foundation/remote';
import { RemoteData } from '@/models/remote';
import { RecordedExercise } from '@/models/session-models';
import { ExerciseHistoryCursor } from '@/services/session-history-repository';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Href } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

export function getExerciseHistoryHref(blueprint: ExerciseBlueprint): Href {
  return `/exercise-history?name=${encodeURIComponent(blueprint.name)}&type=${blueprint.type}` as Href;
}

export function ExerciseHistory(props: { movementKey: MovementKey; exerciseName: string }) {
  const { sessionHistoryRepository } = useServices();
  const [exercises, setExercises] = useState<RecordedExercise[]>([]);
  const [load, setLoad] = useState<RemoteData<boolean>>(RemoteData.loading());
  const cursor = useRef<ExerciseHistoryCursor | undefined>(undefined);
  const busy = useRef(false);
  const done = useRef(false);
  const alive = useRef(true);
  const loadMore = async () => {
    if (busy.current || done.current) return;
    busy.current = true;
    setLoad(RemoteData.loading());

    try {
      const page = await sessionHistoryRepository.getExerciseHistory(props.movementKey, cursor.current);
      if (!alive.current) return;
      cursor.current = page.next;
      done.current = !page.next;
      setExercises((existing) => [...existing, ...page.exercises]);
      setLoad(RemoteData.success(true));
    } catch (error) {
      if (alive.current) setLoad(RemoteData.error(String(error)));
    } finally {
      busy.current = false;
    }
  };
  const loadInitialPage = useEffectEvent(() => {
    void loadMore();
  });
  useEffect(() => {
    alive.current = true;
    loadInitialPage();
    return () => {
      alive.current = false;
    };
  }, []);

  return (
    <SafeAreaView edges={{ left: 'additive', right: 'additive', top: 'off', bottom: 'off' }} style={{ flex: 1 }}>
      <SurfaceText
        font="text-xl"
        weight="bold"
        numberOfLines={1}
        style={{ paddingHorizontal: spacing.pageHorizontalMargin, paddingTop: spacing[3] }}
      >
        {props.exerciseName}
      </SurfaceText>
      {exercises.length ? (
        <ExerciseHistoryList
          exercises={exercises}
          onEndReached={() => {
            if (load.isSuccess()) void loadMore();
          }}
          footer={<Remote value={load} retry={() => void loadMore()} success={() => null} />}
          contentContainerStyle={{
            paddingHorizontal: spacing.pageHorizontalMargin,
            paddingTop: spacing[2],
            paddingBottom: spacing[8],
          }}
        />
      ) : (
        <Remote value={load} retry={() => void loadMore()} success={() => <ExerciseHistoryList exercises={[]} />} />
      )}
    </SafeAreaView>
  );
}
