import { Backend } from '@/models/backend';
import { backupProbeHeader, probeBackendFeatures, probeBackupEndpoint } from '@/services/backend-probe';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend: Backend = {
  id: 'self',
  name: 'Home server',
  url: 'https://liftlog.example.com',
  kind: 'liftlog',
  headers: [{ name: 'X-Api-Key', value: 'secret' }],
};

function respondWith(response: Partial<Response> | Error) {
  const fetchMock = vi.fn((..._args: unknown[]) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ok(body: unknown): Partial<Response> {
  return { ok: true, json: () => Promise.resolve(body) };
}

afterEach(() => vi.unstubAllGlobals());

describe('probeBackendFeatures', () => {
  it('asks /features with the backend headers', async () => {
    const fetchMock = respondWith(ok({ feed: true }));

    await probeBackendFeatures(backend);

    expect(fetchMock).toHaveBeenCalledWith('https://liftlog.example.com/features', {
      headers: { 'X-Api-Key': 'secret' },
    });
  });

  it('reports only the features that are switched on', async () => {
    respondWith(ok({ feed: true, aiPlanner: false, backup: true }));

    expect(await probeBackendFeatures(backend)).toEqual({ status: 'ok', features: ['feed', 'backup'] });
  });

  it('is unreachable when the request fails outright', async () => {
    respondWith(new TypeError('Network request failed'));

    expect(await probeBackendFeatures(backend)).toEqual({ status: 'unreachable' });
  });

  it('is not a LiftLog backend on an error status', async () => {
    respondWith({ ok: false, json: () => Promise.resolve({}) });

    expect(await probeBackendFeatures(backend)).toEqual({ status: 'notLiftLog' });
  });

  // Anything with a web server on it answers 200 with a page. That is not an answer to this question.
  it('is not a LiftLog backend when the body is not a feature object', async () => {
    respondWith({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
    expect(await probeBackendFeatures(backend)).toEqual({ status: 'notLiftLog' });

    respondWith(ok(['feed']));
    expect(await probeBackendFeatures(backend)).toEqual({ status: 'notLiftLog' });

    respondWith(ok(null));
    expect(await probeBackendFeatures(backend)).toEqual({ status: 'notLiftLog' });
  });
});

describe('probeBackupEndpoint', () => {
  it('posts an empty body, marked as a probe, with the backend headers', async () => {
    const fetchMock = respondWith({ ok: true });

    await probeBackupEndpoint({ ...backend, kind: 'backupEndpoint', url: 'https://example.com/lambda' });

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/lambda', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        [backupProbeHeader]: 'true',
        'X-Api-Key': 'secret',
      },
      body: new Uint8Array(),
    });
  });

  // A LiftLog backend's URL is a base, so its backups - and this probe - go to /backup on it.
  it('probes /backup on a liftlog backend', async () => {
    const fetchMock = respondWith({ ok: true });

    await probeBackupEndpoint(backend);

    expect(fetchMock).toHaveBeenCalledWith('https://liftlog.example.com/backup', expect.anything());
  });

  it('reports the status when the endpoint refuses', async () => {
    respondWith({ ok: false, status: 401 });

    expect(await probeBackupEndpoint(backend)).toEqual({ status: 'refused', statusCode: 401 });
  });

  it('is unreachable when the request fails outright', async () => {
    respondWith(new TypeError('Network request failed'));

    expect(await probeBackupEndpoint(backend)).toEqual({ status: 'unreachable' });
  });
});
