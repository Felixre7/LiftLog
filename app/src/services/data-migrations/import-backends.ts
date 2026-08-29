import { backendAssignmentsSchema, backendHeadersSchema, backendsSchema, dataMigrationsSchema } from '@/db/schema';
import { normalizeBackendUrl } from '@/models/backend';
import { uuid } from '@/utils/uuid';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { PreferenceService } from '../preference-service';

export const importBackendsDataMigration = 'IMPORT_BACKENDS';

// Names the backend after its host so the list reads as somewhere rather than as a URL.
function nameFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'Backup server';
  }
}

/**
 * Lifts the old single remote-backup endpoint into a backend. The saved endpoint is a full URL the
 * user typed - possibly a bare implementation of the backup protocol at an arbitrary path - so it
 * becomes a `backupEndpoint` backend and is used verbatim, not treated as a base URL.
 */
export async function importBackends(db: ExpoSQLiteDatabase, preferenceService: PreferenceService) {
  const { endpoint, apiKey, includeFeedAccount } = await preferenceService.getRemoteBackupSettings();

  await preferenceService.setPreference('backupIncludeFeedAccount', includeFeedAccount);

  await db.transaction(async (tx) => {
    if (endpoint.trim()) {
      const id = uuid();
      await tx.insert(backendsSchema).values({
        id,
        name: nameFromEndpoint(endpoint),
        url: normalizeBackendUrl(endpoint),
        kind: 'backupEndpoint',
      });
      if (apiKey.trim()) {
        await tx.insert(backendHeadersSchema).values({ backendId: id, name: 'X-Api-Key', value: apiKey });
      }
      await tx.insert(backendAssignmentsSchema).values({ feature: 'backup', backendId: id });
    }
    await tx.insert(dataMigrationsSchema).values({ id: importBackendsDataMigration });
  });
}
