import StackWithHeader from '@/components/layout/stack-with-header';
import { Profiler } from 'react';
import { logStartupRender } from '@/utils/startup-diagnostics';

export default function Layout() {
  return (
    <Profiler id="history stack" onRender={logStartupRender}>
      <StackWithHeader />
    </Profiler>
  );
}
