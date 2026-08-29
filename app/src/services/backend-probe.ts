import { Backend, backendHeaderRecord, backupUrl, featuresUrl } from '@/models/backend';

export type BackendProbeResult =
  | { status: 'ok'; features: string[] }
  | { status: 'notLiftLog' }
  | { status: 'unreachable' };

/**
 * Asks a LiftLog backend what it serves. A server that cannot answer this is not one of ours, and
 * that rules out every feature - a LiftLog backend's URL is a base, so its backups would be posted
 * to `/backup` on the very server that just failed to answer.
 */
export async function probeBackendFeatures(backend: Backend): Promise<BackendProbeResult> {
  let response: Response;
  try {
    response = await fetch(featuresUrl(backend), { headers: backendHeaderRecord(backend) });
  } catch {
    return { status: 'unreachable' };
  }
  if (!response.ok) {
    return { status: 'notLiftLog' };
  }
  try {
    const features: unknown = await response.json();
    if (typeof features !== 'object' || features === null || Array.isArray(features)) {
      return { status: 'notLiftLog' };
    }
    return {
      status: 'ok',
      features: Object.entries(features)
        .filter(([, enabled]) => enabled === true)
        .map(([feature]) => feature),
    };
  } catch {
    return { status: 'notLiftLog' };
  }
}

/** Lets a server answer a probe without storing an empty backup. Documented in docs/RemoteBackup.md. */
export const backupProbeHeader = 'X-LiftLog-Probe';

export type BackupProbeResult =
  | { status: 'ok' }
  | { status: 'refused'; statusCode: number }
  | { status: 'unreachable' };

/**
 * Posts an empty body where a backup would go. The protocol is a bare POST with no handshake, so this
 * is as close as a check gets without uploading the database: it proves the address, the headers and
 * the method. A server that honours the probe header answers without writing anything
 */
export async function probeBackupEndpoint(backend: Backend): Promise<BackupProbeResult> {
  try {
    const response = await fetch(backupUrl(backend), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        [backupProbeHeader]: 'true',
        ...backendHeaderRecord(backend),
      },
      body: new Uint8Array(),
    });
    return response.ok ? { status: 'ok' } : { status: 'refused', statusCode: response.status };
  } catch {
    return { status: 'unreachable' };
  }
}
