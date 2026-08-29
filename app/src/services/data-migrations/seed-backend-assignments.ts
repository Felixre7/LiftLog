import { backendAssignmentsSchema, dataMigrationsSchema } from '@/db/schema';
import { BackendFeature, builtInBackendId } from '@/models/backend';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';

export const seedBackendAssignmentsDataMigration = 'SEED_BACKEND_ASSIGNMENTS';

const servedByUs: BackendFeature[] = ['feed', 'aiPlanner'];

export async function seedBackendAssignments(db: ExpoSQLiteDatabase) {
  await db.transaction(async (tx) => {
    await tx
      .insert(backendAssignmentsSchema)
      .values(servedByUs.map((feature) => ({ feature, backendId: builtInBackendId })))
      .onConflictDoNothing();
    await tx.insert(dataMigrationsSchema).values({ id: seedBackendAssignmentsDataMigration });
  });
}
