import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import { createAzure } from './azure.ts';
import { CloudError, safeMessage } from './cloud.ts';
import { createDrive } from './drive.ts';
import { migrateFiles, type Transfer } from './migration.ts';

type Job = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  message?: string;
  files: Transfer[];
  events: EventEmitter;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createApp(env = process.env) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  const jobs = new Map<string, Job>();
  let active = false;
  let deletions = 0;
  const token = env.ADMIN_API_TOKEN;
  const expected = token && token.length >= 32 && !/\s/.test(token) && !token.startsWith('SUBSTITUA_')
    ? digest(token) : undefined;
  const admin: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!expected) return next(new CloudError('Configure ADMIN_API_TOKEN com um token aleatório de pelo menos 32 caracteres, sem espaços.', 503));
    const candidate = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!candidate || !timingSafeEqual(expected, digest(candidate))) {
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ message: 'Token de administrador inválido ou ausente.' });
      return;
    }
    next();
  };

  function drive() {
    if (!env.GOOGLE_DRIVE_FOLDER_ID || !/^[\w-]+$/.test(env.GOOGLE_DRIVE_FOLDER_ID) || !env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new CloudError('Configure GOOGLE_DRIVE_FOLDER_ID e GOOGLE_SERVICE_ACCOUNT_JSON.', 503);
    }
    return createDrive(env.GOOGLE_DRIVE_FOLDER_ID, env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  function azure() {
    const name = env.AZURE_CONTAINER_NAME;
    if (!name || !/^aluno-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63) {
      throw new CloudError('Configure AZURE_CONTAINER_NAME no formato aluno-nome, em minúsculas, com até 63 caracteres.', 503);
    }
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new CloudError('Configure AZURE_STORAGE_CONNECTION_STRING.', 503);
    return createAzure(env.AZURE_STORAGE_CONNECTION_STRING, name);
  }

  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/api/drive/files', admin, async (_req, res) => { res.json(await drive().listGoogleDriveFiles()); });
  app.get('/api/azure/blobs', admin, async (_req, res) => { res.json(await azure().listAzureBlobs()); });
  function blobName(name: unknown) {
    if (typeof name !== 'string' || !name || name.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(name)
      || name.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new CloudError('Informe um nome de blob válido.', 400);
    }
    return name;
  }
  app.delete('/api/azure/blobs', admin, async (req, res) => {
    const name = blobName(req.query.name);
    if (active) throw new CloudError('Aguarde a conclusão da migração para excluir blobs.', 409);
    deletions++;
    try { await azure().deleteBlob(name, AbortSignal.timeout(30_000)); }
    finally { deletions--; }
    res.sendStatus(204);
  });

  app.get('/api/azure/blobs/download', admin, async (req, res) => {
    const name = blobName(req.query.name);
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      const { stream, size, contentType } = await azure().downloadBlob(name, controller.signal);
      const preview = req.query.preview === '1';
      const mime = contentType?.split(';')[0].trim().toLowerCase() ?? '';
      if (preview && !/^(application\/pdf|text\/plain|image\/(png|jpeg|gif|webp|bmp|avif))$/.test(mime)) {
        stream.destroy();
        throw new CloudError('Prévia indisponível para este formato. Use Baixar para abrir o arquivo.', 415);
      }
      if (preview && (size === undefined || size > 20 * 1024 * 1024)) {
        stream.destroy();
        throw new CloudError('A prévia aceita arquivos de até 20 MB. Use Baixar para abrir o arquivo.', 413);
      }
      res.attachment(name.split('/').at(-1) || 'arquivo').type(preview ? mime : 'application/octet-stream');
      if (size !== undefined) res.set('Content-Length', String(size));
      await pipeline(stream, res, { signal: controller.signal });
    } catch (error) {
      if (res.destroyed) return;
      throw error;
    } finally {
      res.off('close', disconnect);
    }
  });
  app.post('/api/migrations', admin, express.json({ limit: '128kb' }), (req, res) => {
    const policy = req.body?.duplicatePolicy;
    if ((policy !== 'skip' && policy !== 'overwrite') || Object.keys(req.body).some(key => key !== 'duplicatePolicy' && key !== 'fileIds')) {
      throw new CloudError('Envie duplicatePolicy como skip ou overwrite.', 400);
    }
    const ids: unknown = req.body.fileIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 500
      || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)))) {
      throw new CloudError('Selecione de 1 a 500 arquivos válidos ou use a opção Todos os arquivos.', 400);
    }
    const selected = Array.isArray(ids) ? new Set<string>(ids) : undefined;
    if (active || deletions) throw new CloudError('Aguarde a conclusão da operação atual no Azure.', 409);
    const source = drive();
    const target = azure();
    const job: Job = {
      id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), files: [], events: new EventEmitter()
    };
    jobs.set(job.id, job);
    if (jobs.size > 20) jobs.delete(jobs.keys().next().value!);
    active = true;
    res.status(202).location(`/api/migrations/${job.id}`).json(snapshot(job));
    void migrateFiles(source, target, policy, (files, changed) => {
      job.files = files;
      job.events.emit('update', changed);
    }, selected).then(() => {
      job.status = 'completed';
    }).catch(error => {
      job.status = 'failed';
      job.message = safeMessage(error, 'Preparação da migração');
      console.error(JSON.stringify({ evento: 'migracao', id: job.id, status: job.status, mensagem: job.message }));
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      active = false;
      job.events.emit('update');
    });
  });

  function findJob(id: string | string[]) {
    const job = typeof id === 'string' ? jobs.get(id) : undefined;
    if (!job) throw new CloudError('Migração não encontrada nesta instância.', 404);
    return job;
  }

  app.get('/api/migrations/:id', admin, (req, res) => { res.json(snapshot(findJob(req.params.id))); });
  app.get('/api/migrations/:id/events', admin, (req, res) => {
    const job = findJob(req.params.id);
    if (job.events.listenerCount('update') >= 8) throw new CloudError('Limite de conexões de progresso atingido.', 429);
    res.set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    const write = (data: unknown) => {
      if (!res.write(`data: ${JSON.stringify(data)}\n\n`)) res.destroy();
    };
    const update = (changed?: Transfer) => {
      write(changed ? { changed } : { snapshot: snapshot(job) });
      if (job.status !== 'running') res.end();
    };
    update();
    if (job.status !== 'running' || res.destroyed) return;
    const heartbeat = setInterval(() => { if (!res.write(': ping\n\n')) res.destroy(); }, 15_000);
    job.events.on('update', update);
    res.once('close', () => {
      clearInterval(heartbeat);
      job.events.off('update', update);
    });
  });

  app.use('/api', (_req, res) => { res.status(404).json({ message: 'Endpoint não encontrado.' }); });
  const web = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  if (existsSync(web)) app.use(express.static(web));
  app.use(((error, _req, res, _next) => {
    const status = error instanceof CloudError ? error.status : error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    const message = error instanceof CloudError ? error.message : status === 413 ? 'Corpo da requisição excede 128 KB.'
      : status === 400 ? 'Corpo JSON inválido.' : 'Erro interno do servidor.';
    res.status(status).json({ message });
  }) satisfies express.ErrorRequestHandler);
  return app;
}

function snapshot({ events: _events, ...job }: Job) { return job; }
