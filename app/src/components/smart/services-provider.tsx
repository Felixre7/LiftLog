import { Services } from '@/services';
import { resolveStore } from '@/store';
import { registerDateTranslations } from '@/utils/date-locale';
import { TolgeeProvider } from '@tolgee/react';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { Provider } from 'react-redux';
import { markStartup } from '@/utils/startup-diagnostics';

// Create context for services
const ServicesContext = createContext<Services | null>(null);

let databasePromise: Promise<SQLiteDatabase> | undefined;
function openDatabase() {
  if (!databasePromise) {
    markStartup('database open started');
    databasePromise = openDatabaseAsync('db.db').then((db) => {
      markStartup('database open finished');
      return db;
    });
  }
  return databasePromise;
}

export default function ServicesProvider(props: { children: ReactNode }) {
  const [expoDb, setOpDb] = useState<SQLiteDatabase>();
  useEffect(() => {
    void openDatabase().then(setOpDb);
  }, [setOpDb]);
  return expoDb ? <ResolvedServicesProvider expoDb={expoDb}>{props.children}</ResolvedServicesProvider> : null;
}

function ResolvedServicesProvider({ expoDb, children }: { expoDb: SQLiteDatabase; children: ReactNode }) {
  // The store owns loaded history and active edits. React may discard memo caches (including during
  // Fast Refresh), so its lifetime must be component state rather than a useMemo calculation.
  const [{ store, services }] = useState(() => resolveStore(drizzle(expoDb), expoDb));
  useEffect(() => {
    if (services) {
      registerDateTranslations(services.tolgee);
      markStartup('services provider committed');
    }
  }, [services]);
  return (
    <Provider store={store}>
      <ServicesContext.Provider value={services}>
        <TolgeeProvider tolgee={services.tolgee}>{children}</TolgeeProvider>
      </ServicesContext.Provider>
    </Provider>
  );
}
export function useServices() {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error('useServices must be used within AppStateProvider');
  return ctx;
}
