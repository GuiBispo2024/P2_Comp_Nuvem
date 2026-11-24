import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import * as driveModule from '../src/drive.js';
import * as azureModule from '../src/azure.js';

it('protege operações do blob e transmite apenas os arquivos selecionados', async () => {
  const file = { id: '1', name: 'a.txt', path: 'a.txt', blobName: 'a.txt', mimeType: 'text/plain', size: '1', modifiedTime: null };
  const token = 'b'.repeat(64);
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const drive = vi.spyOn(driveModule, 'createDrive').mockReturnValue({
    listGoogleDriveFiles: async () => { await ready; return [file, { ...file, id: '2', name: 'b.txt', path: 'b.txt', blobName: 'b.txt' }]; },
    open: async () => ({ stream: Readable.from(['a']), contentType: 'text/plain' })
  });
  const deleteBlob = vi.fn().mockResolvedValue(undefined);
  const azure = vi.spyOn(azureModule, 'createAzure').mockReturnValue({
    ensureContainer: async () => undefined,
    listAzureBlobs: async () => [],
    downloadBlob: async name => ({ stream: Readable.from(['a']), size: 1, contentType: name.endsWith('.html') ? 'text/html' : 'text/plain' }),
    deleteBlob,
    exists: async () => false,
    upload: async () => 'success'
  });
  const server = createApp({
    ADMIN_API_TOKEN: token, GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
    AZURE_CONTAINER_NAME: 'aluno-teste', AZURE_STORAGE_CONNECTION_STRING: 'ficticia'
  }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Endereço indisponível');
    const base = 'http://127.0.0.1:' + address.port;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const start = (fileIds = ['1']) => fetch(base + '/api/migrations', {
      method: 'POST', headers, body: JSON.stringify({ duplicatePolicy: 'skip', fileIds })
    });
    const downloadUrl = base + '/api/azure/blobs/download?' + new URLSearchParams({ name: 'pasta/a.txt' });
    expect((await fetch(downloadUrl)).status).toBe(401);
    expect((await fetch(base + '/api/azure/blobs/download?name=../a.txt', { headers })).status).toBe(400);
    const download = await fetch(downloadUrl, { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toMatch(/^attachment; filename="?a\.txt"?$/);
    expect(await download.text()).toBe('a');

    const preview = await fetch(downloadUrl + '&preview=1', { headers });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Type')).toMatch(/^text\/plain/);
    expect(await preview.text()).toBe('a');
    expect((await fetch(base + '/api/azure/blobs/download?name=a.html&preview=1', { headers })).status).toBe(415);

    const deleteUrl = base + '/api/azure/blobs?name=pasta%2Fa.txt';
    expect((await fetch(deleteUrl, { method: 'DELETE' })).status).toBe(401);
    expect(deleteBlob).not.toHaveBeenCalled();
    expect((await fetch(deleteUrl, { method: 'DELETE', headers })).status).toBe(204);
    expect(deleteBlob).toHaveBeenCalledWith('pasta/a.txt', expect.any(AbortSignal));
    expect((await start([])).status).toBe(400);

    const started = await start();
    expect(started.status).toBe(202);
    expect((await start()).status).toBe(409);
    const statusUrl = base + started.headers.get('Location');
    const sse = await fetch(statusUrl + '/events', { headers, signal: AbortSignal.timeout(3000) });
    expect(sse.headers.get('Content-Type')).toMatch(/^text\/event-stream/);
    release();
    const events = (await sse.text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    expect(events[0].snapshot.status).toBe('running');
    expect(events.some(event => event.changed?.status === 'running')).toBe(true);
    expect(events.at(-1).snapshot).toMatchObject({ status: 'completed', files: [{ id: '1', status: 'success' }] });
    expect(await (await fetch(statusUrl, { headers })).json()).toEqual(events.at(-1).snapshot);
  } finally {
    release();
    server.close();
    drive.mockRestore();
    azure.mockRestore();
  }
});
