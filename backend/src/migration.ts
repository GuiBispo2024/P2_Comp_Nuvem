import type { createAzure, DuplicatePolicy } from './azure.ts';
import type { DriveFile, createDrive } from './drive.ts';
import { CloudError, retry, safeMessage } from './cloud.ts';

export type FileStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';
export interface Transfer {
  id: string;
  path: string;
  blobName: string;
  status: FileStatus;
  durationMs?: number;
  message?: string;
}
type Drive = ReturnType<typeof createDrive>;
type Azure = Pick<ReturnType<typeof createAzure>, 'ensureContainer' | 'exists' | 'upload'>;

export async function migrateFiles(drive: Drive, azure: Azure, policy: DuplicatePolicy,
  publish: (files: Transfer[], changed?: Transfer) => void, selected?: ReadonlySet<string>) {
  const listed = await drive.listGoogleDriveFiles();
  const files = selected ? listed.filter(file => selected.has(file.id)) : listed;
  if (selected && files.length !== selected.size) {
    throw new CloudError('Um ou mais arquivos selecionados não estão mais na pasta. Atualize a origem e selecione novamente.', 400);
  }
  if (files.length) await azure.ensureContainer();
  const transfers: Transfer[] = files.map(({ id, path, blobName }) => ({ id, path, blobName, status: 'pending' }));
  publish(transfers);
  for (const [index, file] of files.entries()) {
    const transfer = transfers[index];
    transfer.status = 'running';
    publish(transfers, transfer);
    const started = performance.now();
    try {
      transfer.status = await retry(async signal => {
        if (policy === 'skip' && await azure.exists(file.blobName, signal)) return 'skipped';
        return copy(file, drive, azure, policy, signal);
      }, 10 * 60_000);
      if (transfer.status === 'skipped') transfer.message = 'Blob já existente.';
    } catch (error) {
      transfer.status = 'error';
      transfer.message = safeMessage(error, 'Transferência');
    }
    transfer.durationMs = Math.round(performance.now() - started);
    const log = transfer.status === 'error' ? console.error : console.info;
    log(JSON.stringify({
      evento: 'transferencia', arquivo: transfer.path, status: transfer.status,
      duracaoMs: transfer.durationMs, mensagem: transfer.message
    }));
    publish(transfers, transfer);
  }
}

async function copy(file: DriveFile, drive: Drive, azure: Azure, policy: DuplicatePolicy, signal: AbortSignal) {
  const { stream, contentType } = await drive.open(file, signal);
  try { return await azure.upload(file.blobName, stream, contentType, policy, signal); }
  finally { stream.destroy(); }
}
