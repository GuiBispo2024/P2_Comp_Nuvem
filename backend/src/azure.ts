import type { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import { CloudError, details, retry, safeMessage } from './cloud.ts';

export type DuplicatePolicy = 'skip' | 'overwrite';

export function createAzure(connection: string, containerName: string) {
  let container;
  try {
    container = BlobServiceClient.fromConnectionString(connection, {
      retryOptions: { maxTries: 3, tryTimeoutInMs: 30_000 }
    }).getContainerClient(containerName);
  } catch {
    throw new CloudError('AZURE_STORAGE_CONNECTION_STRING inválida.', 503);
  }
  const client = container;

  async function ensureContainer() {
    try {
      await retry(signal => client.createIfNotExists({ abortSignal: signal }));
    } catch (error) {
      // Uma credencial limitada ao contêiner existente pode listar sem poder criar.
      if (details(error).status === 403) {
        try {
          const pages = client.listBlobsFlat({ abortSignal: AbortSignal.timeout(15_000) }).byPage({ maxPageSize: 1 });
          await pages.next();
          return;
        } catch { /* mantém o erro de permissão da operação inicial */ }
      }
      throw new CloudError(safeMessage(error, 'Acesso ou criação do contêiner Azure'));
    }
  }

  async function listAzureBlobs() {
    await ensureContainer();
    const result: { name: string; size: number | null; modifiedTime: string | null }[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const page = await retry(signal => client.listBlobsFlat({ abortSignal: signal })
          .byPage({ continuationToken, maxPageSize: 1000 }).next());
        if (page.done) break;
        for (const blob of page.value.segment.blobItems) {
          result.push({
            name: blob.name, size: blob.properties.contentLength ?? null,
            modifiedTime: blob.properties.lastModified?.toISOString() ?? null
          });
        }
        continuationToken = page.value.continuationToken;
      } while (continuationToken);
      return result;
    } catch (error) { throw new CloudError(safeMessage(error, 'Listagem de blobs no Azure')); }
  }

  async function upload(name: string, stream: Readable, contentType: string, policy: DuplicatePolicy, signal: AbortSignal) {
    try {
      await client.getBlockBlobClient(name).uploadStream(stream, 4 * 1024 * 1024, 2, {
        abortSignal: signal,
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: policy === 'skip' ? { ifNoneMatch: '*' } : undefined
      });
      return 'success' as const;
    } catch (error) {
      const { status, code } = details(error);
      if (policy === 'skip' && (status === 412 || code === 'BlobAlreadyExists')) return 'skipped' as const;
      throw error;
    }
  }

  async function downloadBlob(name: string, signal: AbortSignal) {
    try {
      const result = await client.getBlobClient(name).download(0, undefined, { abortSignal: signal });
      if (!result.readableStreamBody) throw new CloudError('O Azure não retornou o conteúdo do blob.');
      return { stream: result.readableStreamBody as Readable, size: result.contentLength, contentType: result.contentType };
    } catch (error) {
      if (details(error).status === 404) throw new CloudError('Blob não encontrado.', 404);
      throw new CloudError(safeMessage(error, 'Download do Azure'));
    }
  }

  async function deleteBlob(name: string, signal: AbortSignal) {
    try {
      const result = await client.getBlobClient(name).deleteIfExists({ abortSignal: signal });
      if (!result.succeeded) throw new CloudError('Blob não encontrado.', 404);
    } catch (error) {
      if (details(error).status === 409) throw new CloudError('O Azure bloqueou a exclusão. Confira snapshots, retenção ou outras restrições do blob.', 409);
      throw new CloudError(safeMessage(error, 'Exclusão no Azure'), error instanceof CloudError ? error.status : 502);
    }
  }

  return {
    ensureContainer, listAzureBlobs, upload, downloadBlob, deleteBlob,
    exists: (name: string, signal: AbortSignal) => client.getBlockBlobClient(name).exists({ abortSignal: signal })
  };
}
