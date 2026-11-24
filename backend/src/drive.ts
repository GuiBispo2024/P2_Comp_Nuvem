import { google, type drive_v3 } from 'googleapis';
import { CloudError, details, retry, safeMessage } from './cloud.ts';

const folderMime = 'application/vnd.google-apps.folder';
const office = {
  'application/vnd.google-apps.document': ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  'application/vnd.google-apps.spreadsheet': ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  'application/vnd.google-apps.presentation': ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
} as Record<string, [string, string] | undefined>;

export interface DriveFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: string | null;
  modifiedTime: string | null;
  blobName: string;
}

export function createDrive(folderId: string, serviceAccountJson: string) {
  try {
    const credentials = JSON.parse(serviceAccountJson);
    if (credentials.type !== 'service_account' || typeof credentials.client_email !== 'string'
      || typeof credentials.private_key !== 'string') throw new Error();
    const auth = new google.auth.JWT({
      email: credentials.client_email, key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    return driveService(google.drive({ version: 'v3', auth }).files, folderId);
  } catch {
    throw new CloudError('GOOGLE_SERVICE_ACCOUNT_JSON inválido. Use o JSON de uma conta de serviço.', 503);
  }
}

export function driveService(files: Pick<drive_v3.Resource$Files, 'list' | 'get' | 'export'>, folderId: string) {
  async function listGoogleDriveFiles(): Promise<DriveFile[]> {
    try {
      const root = await retry(signal => files.get({
        fileId: folderId, fields: 'mimeType,trashed', supportsAllDrives: true
      }, { signal, retry: false }));
      if (root.data.mimeType !== folderMime || root.data.trashed) {
        throw new CloudError('GOOGLE_DRIVE_FOLDER_ID deve apontar para uma pasta ativa.');
      }
      const output: DriveFile[] = [];
      const folders = [{ id: folderId, path: '', blobPath: '' }];
      const visited = new Set<string>();
      for (const folder of folders) {
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        let pageToken: string | undefined;
        do {
          const page = await retry(signal => files.list({
            q: `'${folder.id}' in parents and trashed = false`,
            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
            pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true
          }, { signal, retry: false }));
          for (const entry of page.data.files ?? []) {
            if (!entry.id || !entry.name || !entry.mimeType) continue;
            const path = folder.path + entry.name;
            const segment = entry.name.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll('\\', '%5C')
              .replace(/[. ]+$/, suffix => [...suffix].map(char => char === '.' ? '%2E' : '%20').join(''));
            const blobPath = folder.blobPath + segment;
            if (entry.mimeType === folderMime) {
              folders.push({ id: entry.id, path: path + '/', blobPath: blobPath + '/' });
              continue;
            }
            const extension = office[entry.mimeType]?.[0];
            const blobName = extension && !blobPath.toLowerCase().endsWith(extension) ? blobPath + extension : blobPath;
            output.push({
              id: entry.id, name: entry.name, path, mimeType: entry.mimeType, blobName,
              size: entry.size ?? null, modifiedTime: entry.modifiedTime ?? null
            });
          }
          pageToken = page.data.nextPageToken ?? undefined;
        } while (pageToken);
      }
      return output.sort((a, b) => a.blobName.localeCompare(b.blobName, 'pt-BR') || a.id.localeCompare(b.id));
    } catch (error) {
      throw new CloudError(safeMessage(error, 'Listagem do Google Drive'));
    }
  }

  async function open(file: DriveFile, signal: AbortSignal) {
    const conversion = office[file.mimeType];
    if (!conversion && file.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new CloudError('Tipo nativo ou atalho do Google Drive sem suporte de exportação.');
    }
    const options = { responseType: 'stream' as const, signal, retry: false };
    try {
      const response = conversion
        ? await files.export({ fileId: file.id, mimeType: conversion[1] }, options)
        : await files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, options);
      return { stream: response.data, contentType: conversion?.[1] ?? file.mimeType };
    } catch (error) {
      const { status, reason } = details(error);
      if (conversion && (status === 400 || status === 413 || reason === 'exportSizeLimitExceeded')) {
        throw new CloudError('O Drive recusou a exportação. Confira o formato e o limite de 10 MB.');
      }
      throw error;
    }
  }

  return { listGoogleDriveFiles, open };
}
