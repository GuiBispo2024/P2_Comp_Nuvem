import { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import { afterEach, expect, it, vi } from 'vitest';
import { createAzure } from '../src/azure.js';

afterEach(() => vi.restoreAllMocks());

it('percorre as páginas do Azure e protege gravações em modo ignorar', async () => {
  const item = (name: string) => ({ name, properties: { contentLength: 1, lastModified: new Date(0) } });
  const next = vi.fn()
    .mockResolvedValueOnce({ value: { segment: { blobItems: [item('a')] }, continuationToken: 'p2' } })
    .mockResolvedValueOnce({ value: { segment: { blobItems: [item('b')] } } });
  const byPage = vi.fn().mockReturnValue({ next });
  const createIfNotExists = vi.fn().mockResolvedValue(undefined);
  const uploadStream = vi.fn().mockRejectedValue({ statusCode: 412 });
  const getContainerClient = vi.fn().mockReturnValue({
    createIfNotExists, listBlobsFlat: () => ({ byPage }),
    getBlockBlobClient: () => ({ uploadStream })
  });
  vi.spyOn(BlobServiceClient, 'fromConnectionString')
    .mockReturnValue({ getContainerClient } as unknown as BlobServiceClient);
  const azure = createAzure('fictícia', 'aluno-teste');
  expect(await azure.listAzureBlobs()).toEqual(['a', 'b'].map(name => ({
    name, size: 1, modifiedTime: '1970-01-01T00:00:00.000Z'
  })));
  expect(createIfNotExists).toHaveBeenCalledOnce();
  expect(byPage).toHaveBeenNthCalledWith(2, { continuationToken: 'p2', maxPageSize: 1000 });
  expect(await azure.upload('a', Readable.from(['a']), 'text/plain', 'skip', AbortSignal.timeout(1000))).toBe('skipped');
  expect(uploadStream).toHaveBeenCalledWith(expect.any(Readable), expect.any(Number), expect.any(Number),
    expect.objectContaining({ conditions: { ifNoneMatch: '*' } }));
});
