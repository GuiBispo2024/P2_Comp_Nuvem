import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveService, type DriveFile } from '../src/drive.js';
import { migrateFiles, type Transfer } from '../src/migration.js';
import { createApp } from '../src/app.js';

const folder = 'application/vnd.google-apps.folder';
const entry = (id: string, name: string, mimeType = 'text/plain') => ({ id, name, mimeType, size: '3' });

afterEach(() => vi.restoreAllMocks());

it('percorre páginas e subpastas e define nome e MIME de exportação', async () => {
  const get = vi.fn().mockResolvedValue({ data: { mimeType: folder } });
  const list = vi.fn()
    .mockResolvedValueOnce({ data: { nextPageToken: 'p2', files: [entry('1', 'a.txt'), entry('sub', 'sub', folder)] } })
    .mockResolvedValueOnce({ data: { files: [entry('2', 'b.txt')] } })
    .mockResolvedValueOnce({ data: { files: [entry('3', 'aula', 'application/vnd.google-apps.document')] } });
  const exportFile = vi.fn().mockResolvedValue({ data: Readable.from(['doc']) });
  const drive = driveService({ get, list, export: exportFile }, 'root');
  const files = await drive.listGoogleDriveFiles();
  expect(files.map(file => file.blobName)).toEqual(['a.txt', 'b.txt', 'sub/aula.docx']);
  expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'p2' }), expect.anything());
  expect(list).toHaveBeenNthCalledWith(3, expect.objectContaining({ q: "'sub' in parents and trashed = false" }), expect.anything());
  await drive.open(files[2], new AbortController().signal);
  expect(exportFile).toHaveBeenCalledWith(expect.objectContaining({
    fileId: '3', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }), expect.objectContaining({ responseType: 'stream' }));
});

describe('migrateFiles', () => {
  function setup() {
    const files: DriveFile[] = ['um', 'dois'].map(id => ({
      id, name: id + '.txt', path: id + '.txt', blobName: id + '.txt',
      mimeType: 'text/plain', size: '3', modifiedTime: null
    }));
    const drive = {
      listGoogleDriveFiles: vi.fn().mockResolvedValue(files),
      open: vi.fn(async (file: DriveFile) => ({ stream: Readable.from([file.id]), contentType: file.mimeType }))
    };
    const contents = new Map<string, string>();
    const azure = {
      ensureContainer: vi.fn().mockResolvedValue(undefined),
      listAzureBlobs: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      upload: vi.fn(async (name: string, stream: Readable, _mime: string, _policy: string) => {
        let content = '';
        for await (const part of stream) content += part;
        contents.set(name, content);
        return 'success' as const;
      })
    };
    const states: string[][] = [];
    const publish = (transfers: Transfer[]) => states.push(transfers.map(file => file.status));
    return { drive, azure, contents, states, publish };
  }

  it('copia o conteúdo dos streams e publica os estados', async () => {
    const { drive, azure, contents, states, publish } = setup();
    await migrateFiles(drive, azure, 'skip', publish);
    expect(contents).toEqual(new Map([['um.txt', 'um'], ['dois.txt', 'dois']]));
    expect(states).toEqual([
      ['pending', 'pending'], ['running', 'pending'], ['success', 'pending'],
      ['success', 'running'], ['success', 'success']
    ]);
  });

  it('continua após erro individual e protege logs contra detalhes do SDK', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { drive, azure, states, publish } = setup();
    azure.upload.mockRejectedValueOnce(new Error('detalhe confidencial'));
    await migrateFiles(drive, azure, 'skip', publish);
    expect(states.at(-1)).toEqual(['error', 'success']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('um.txt'));
    expect(log.mock.calls[0][0]).not.toContain('detalhe confidencial');
  });

  it('ignora blobs existentes antes de abrir o stream', async () => {
    const { drive, azure, states, publish } = setup();
    azure.exists.mockResolvedValueOnce(true);
    await migrateFiles(drive, azure, 'skip', publish);
    expect(drive.open).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual(['skipped', 'success']);
  });

  it('envia overwrite para o Azure sem exigir consulta de existência', async () => {
    const { drive, azure, contents, publish } = setup();
    contents.set('um.txt', 'versão anterior');
    await migrateFiles(drive, azure, 'overwrite', publish);
    expect(azure.exists).not.toHaveBeenCalled();
    expect(azure.upload).toHaveBeenCalledWith('um.txt', expect.any(Readable), 'text/plain', 'overwrite', expect.any(AbortSignal));
    expect(contents.get('um.txt')).toBe('um');
  });
});

it('expõe health e protege listagens, criação, consultas e eventos', async () => {
  const token = 'a'.repeat(64);
  const app = createApp({ ADMIN_API_TOKEN: token });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Endereço indisponível');
    const base = 'http://127.0.0.1:' + address.port + '/api';
    expect((await fetch(base + '/health')).status).toBe(200);
    for (const [path, method] of [['/drive/files', 'GET'], ['/azure/blobs', 'GET'], ['/migrations', 'POST'], ['/migrations/x', 'GET'], ['/migrations/x/events', 'GET']]) {
      expect((await fetch(base + path, { method })).status).toBe(401);
    }
    expect((await fetch(base + '/migrations', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicatePolicy: 'inválida' })
    })).status).toBe(400);
  } finally {
    server.close();
  }
});
