import { ExerciseHistory } from '@/components/smart/exercise-history';
import { ExerciseBlueprint, movementKeyFor } from '@/models/blueprint-models';
import { useLocalSearchParams } from 'expo-router';
import { Profiler } from 'react';
import { logStartupRender } from '@/utils/startup-diagnostics';

export default function ExerciseHistoryPage() {
  const { name, type } = useLocalSearchParams<{
    name: string;
    type: ExerciseBlueprint['type'];
  }>();
  return (
    <Profiler id="exercise history" onRender={logStartupRender}>
      <ExerciseHistory key={`${type}:${name}`} exerciseName={name} movementKey={movementKeyFor(name, type)} />
    </Profiler>
  );
}
