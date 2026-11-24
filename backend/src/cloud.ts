import { setTimeout as delay } from 'node:timers/promises';

export class CloudError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function details(error: unknown) {
  type ErrorBody = { error?: { errors?: { reason?: string }[] } };
  const e = error as {
    code?: unknown; statusCode?: number; response?: {
      status?: number; data?: ErrorBody | string;
      headers?: { get?: (key: string) => string | null }
    }
  } | null;
  let body = e?.response?.data;
  if (typeof body === 'string' && body.length <= 32_768) {
    try { body = JSON.parse(body) as ErrorBody; } catch { body = undefined; }
  }
  return {
    status: e?.statusCode ?? e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined),
    code: e?.code,
    reason: typeof body === 'object' ? body?.error?.errors?.[0]?.reason : undefined,
    retryAfter: e?.response?.headers?.get?.('retry-after')
  };
}

export async function retry<T>(task: (signal: AbortSignal) => Promise<T>, timeout = 30_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(timeout);
    try { return await task(signal); } catch (error) {
      const { status, code, reason, retryAfter } = details(error);
      const transient = signal.aborted || status === 408 || status === 429 || (status != null && status >= 500)
        || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
        || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'REQUEST_SEND_ERROR', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(code));
      if (!transient || attempt >= 2) {
        if (signal.aborted) throw new CloudError('Tempo limite excedido na operação com a nuvem.');
        throw error;
      }
      const headerDelay = retryAfter ? (Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      await delay(Math.min(60_000, Math.max(headerDelay || 0, 500 * 2 ** attempt + Math.random() * 250)));
    }
  }
}

export function safeMessage(error: unknown, action: string) {
  if (error instanceof CloudError) return error.message;
  switch (details(error).status) {
    case 401:
    case 403: return `${action}: acesso negado. Confira credenciais, permissões e restrições de download.`;
    case 404: return `${action}: recurso ausente ou sem acesso.`;
    case 429: return `${action}: limite de requisições atingido. Tente novamente mais tarde.`;
    default: return `${action}: falha na comunicação com o serviço ou na leitura do arquivo.`;
  }
}
