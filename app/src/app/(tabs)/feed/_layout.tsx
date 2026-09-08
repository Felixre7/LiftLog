import StackWithHeader from '@/components/layout/stack-with-header';
import { SessionActivityGate } from '@/components/smart/session-activity-gate';

export const unstable_settings = {
  initialRouteName: 'index',
};
export default function Layout() {
  return (
    <SessionActivityGate>
      <StackWithHeader />
    </SessionActivityGate>
  );
}
