import StackWithHeader from '@/components/layout/stack-with-header';
import { SessionActivityGate } from '@/components/smart/session-activity-gate';
import { Profiler } from 'react';
import { logStartupRender } from '@/utils/startup-diagnostics';

export const unstable_settings = {
  initialRouteName: 'index',
};
export default function Layout() {
  return (
    <Profiler id="feed stack" onRender={logStartupRender}>
      <SessionActivityGate>
        <StackWithHeader />
      </SessionActivityGate>
    </Profiler>
  );
}
