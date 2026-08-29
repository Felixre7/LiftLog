export type BackendId = string;

/**
 * `liftlog` - a full LiftLog backend. `url` is a base; each feature appends its own path.
 * `backupEndpoint` - a bare implementation of the backup protocol (see docs/RemoteBackup.md).
 * `url` is the literal POST target, and backup is the only feature it can serve.
 */
export type BackendKind = 'liftlog' | 'backupEndpoint';

export type BackendFeature = 'feed' | 'aiPlanner' | 'backup';

export const backendFeatures: BackendFeature[] = ['feed', 'aiPlanner', 'backup'];

export function canBeSetToNoBackend(feature: BackendFeature): boolean {
  return feature === 'backup';
}

export interface BackendHeader {
  name: string;
  value: string;
}

export interface Backend {
  id: BackendId;
  name: string;
  url: string;
  kind: BackendKind;
  headers: BackendHeader[];
}

export type BackendAssignments = Partial<Record<BackendFeature, BackendId>>;

/** A backend, plus everything a caller needs to actually talk to it for one feature. */
export interface ResolvedBackend {
  backend: Backend;
  url: string;
  headers: Record<string, string>;
  isBuiltIn: boolean;
}

export const builtInBackendId = 'liftlog';

/**
 * We do not hold anyone's backup - ours serves the features we run, and a backup goes somewhere the
 * user controls. A self-hosted LiftLog server serves everything; a bare endpoint serves only backup.
 */
export function backendSupportsFeature(backend: Backend, feature: BackendFeature): boolean {
  if (backend.id === builtInBackendId) {
    return feature !== 'backup';
  }
  return backend.kind === 'liftlog' || feature === 'backup';
}

export function backendHeaderRecord(backend: Backend): Record<string, string> {
  return Object.fromEntries(
    backend.headers.filter((h) => h.name.trim() && h.value).map((h) => [h.name.trim(), h.value]),
  );
}

export function backupUrl(backend: Backend): string {
  return backend.kind === 'backupEndpoint' ? backend.url : `${backend.url}/backup`;
}

export function featuresUrl(backend: Backend): string {
  return `${backend.url}/features`;
}

export function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
