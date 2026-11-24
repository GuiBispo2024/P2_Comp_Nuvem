import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type DriveFile = { id: string; path: string; mimeType: string; size: string | null; modifiedTime: string | null };
type BlobFile = { name: string; size: number | null; modifiedTime: string | null };
type Transfer = { id: string; path: string; blobName: string; status: 'pending' | 'running' | 'success' | 'error' | 'skipped'; durationMs?: number; message?: string };
type Job = { id: string; status: 'running' | 'completed' | 'failed'; files: Transfer[]; message?: string };
const labels = { pending: 'Pendente', running: 'Em andamento', success: 'Sucesso', error: 'Erro', skipped: 'Ignorado' };
const date = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const size = (value: string | number | null) => {
  if (value === null) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return bytes + ' B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return (bytes / 1024 ** unit).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Falha na comunicação com o servidor.';

async function request(path: string, token: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + token);
  let response: Response;
  try {
    response = await fetch('/api' + path, { ...options, headers });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Falha de conexão com a API. Confira se o servidor está ativo.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Falha HTTP ${response.status}.`);
  }
  return response;
}

function useListing<T>(endpoint: string, token: string) {
  const [rows, setRows] = useState<T[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try { setRows(await (await request(endpoint, token)).json()); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return { rows, busy, error, load, setRows };
}

async function watchJob(id: string, token: string, signal: AbortSignal, update: (event: { snapshot?: Job; changed?: Transfer }) => void) {
  const response = await request(`/migrations/${id}/events`, token, { signal });
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error('Fluxo de progresso indisponível.');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      let delimiter;
      while ((delimiter = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          update(event);
          if (event.snapshot && event.snapshot.status !== 'running') return;
        }
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

function App() {
  const [token, setToken] = useState('');
  const [policy, setPolicy] = useState('skip');
  const [scope, setScope] = useState('all');
  const [selection, setSelection] = useState(new Set<string>());
  const [deleted, setDeleted] = useState(new Set<string>());
  const [job, setJob] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const drive = useListing<DriveFile>('/drive/files', token);
  const azure = useListing<BlobFile>('/azure/blobs', token);
  const running = job?.status === 'running';
  const id = job?.id;
  const selectedIds = (drive.rows ?? []).filter(file => selection.has(file.id)).map(file => file.id);
  const invalidSelection = scope === 'selected' && (selectedIds.length === 0 || selectedIds.length > 500);

  function toggleFile(id: string) {
    setScope('selected');
    setSelection(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function removeBlob(name: string) {
    azure.setRows(rows => rows?.filter(file => file.name !== name));
    setDeleted(previous => new Set(previous).add(name));
  }

  useEffect(() => {
    if (!id || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    function poll() {
      timer = setTimeout(async () => {
        try {
          const latest: Job = await (await request(`/migrations/${id}`, token, { signal: controller.signal })).json();
          if (controller.signal.aborted) return;
          setJob(latest);
          if (latest.status === 'running') poll();
          else setConnection('');
        } catch (error) {
          if (!controller.signal.aborted) {
            setConnection('Consulta de progresso indisponível. ' + message(error));
            poll();
          }
        }
      }, 2000);
    }
    let finished = false;
    function usePolling() {
      if (finished || controller.signal.aborted) return;
      setConnection('Atualizando progresso por consulta periódica.');
      poll();
    }
    void watchJob(id, token, controller.signal, event => {
      if (event.snapshot) {
        finished = event.snapshot.status !== 'running';
        setJob(event.snapshot);
      } else if (event.changed) {
        setJob(previous => previous && { ...previous, files: previous.files.map(file => file.id === event.changed!.id ? event.changed! : file) });
      }
    }).then(usePolling, usePolling);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, running, token]);

  async function start() {
    setError('');
    setConnection('');
    setBusy(true);
    try {
      const response = await request('/migrations', token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicatePolicy: policy, ...(scope === 'selected' && { fileIds: selectedIds }) })
      });
      setJob(await response.json());
      setDeleted(new Set());
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  const files = job?.files ?? [];
  const success = files.filter(file => file.status === 'success').length;
  const failed = files.filter(file => file.status === 'error').length;
  const skipped = files.filter(file => file.status === 'skipped').length;
  const processed = success + failed + skipped;
  const percent = files.length ? Math.round(100 * processed / files.length) : job?.status === 'completed' ? 100 : 0;

  return <>
    <header><div className="shell brand"><span aria-hidden="true">⇄</span> FATEC Cotia <small>Computação em Nuvem II · P2</small></div></header>
    <main className="shell">
      <h1>Migração Google Drive <span>→</span> Azure Blob Storage</h1>
      <p className="intro">Copie arquivos do Google Drive e acompanhe cada transferência.</p>

      <section className="card controls" aria-label="Configuração da migração">
        <label>Token de administrador<input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy || running}
          onChange={event => setToken(event.target.value.trim())} placeholder="Informe o token de acesso" /></label>
        <label>Quando o blob já existir<select value={policy} disabled={busy || running} onChange={event => setPolicy(event.target.value)}>
          <option value="skip">Ignorar arquivo</option><option value="overwrite">Sobrescrever blob</option>
        </select></label>
        <button className="primary" disabled={!token || busy || running || invalidSelection || (scope === 'selected' && drive.busy)} onClick={start}>{busy ? 'Iniciando…' : running ? 'Migração em andamento' : scope === 'selected' ? 'Enviar selecionados' : 'Enviar todos'}</button>
        {error && <p className="alert" role="alert">{error}</p>}
      </section>

      <div className="panels">
        <section className="card">
          <div className="heading"><div><h2>Origem</h2><p>Google Drive</p></div>
            <button disabled={!token || drive.busy} onClick={drive.load}>{drive.busy ? 'Listando…' : 'Listar origem'}</button></div>
          <label className="scope">Arquivos para enviar
            <select value={scope} disabled={busy || running} onChange={event => setScope(event.target.value)}>
              <option value="all">Todos os arquivos</option><option value="selected">Somente selecionados</option>
            </select>
          </label>
          {scope === 'selected' && <p role="status">{selectedIds.length} selecionado(s). {selectedIds.length > 500 ? 'Selecione até 500 por envio.' : ''}</p>}
          <Listing actions selection error={drive.error} busy={drive.busy} rows={drive.rows?.map(file =>
            <tr key={file.id}><td><input className="file-check" type="checkbox" aria-label={'Selecionar ' + file.path}
              checked={selection.has(file.id)} disabled={busy || running} onChange={() => toggleFile(file.id)} /></td>
              <td>{file.path}<small>{file.mimeType}</small></td><td>{size(file.size)}</td><td>{date(file.modifiedTime)}</td>
              <td><a href={'https://drive.google.com/open?id=' + encodeURIComponent(file.id)} target="_blank" rel="noopener noreferrer">Visualizar</a></td></tr>)} />
        </section>
        <section className="card">
          <div className="heading"><div><h2>Destino</h2><p>Azure Blob Storage</p></div>
            <button disabled={!token || azure.busy} onClick={azure.load}>{azure.busy ? 'Listando…' : 'Listar destino'}</button></div>
          <Listing actions error={azure.error} busy={azure.busy} rows={azure.rows?.map(file =>
            <tr key={file.name}><td>{file.name}</td><td>{size(file.size)}</td><td>{date(file.modifiedTime)}</td><td><BlobActions name={file.name} token={token} onDelete={removeBlob} blockDelete={busy || running} /></td></tr>)} />
        </section>
      </div>

      <section className="card progress">
        <div className="heading"><h2>Andamento da migração</h2><strong>{percent}%</strong></div>
        <progress aria-label="Progresso da migração" value={percent} max={100} />
        <div className="metrics">
          <div><strong>{processed}/{files.length}</strong>Processados</div>
          <div><strong>{success}</strong>Com sucesso</div>
          <div><strong>{failed}</strong>Com erro</div>
          <div><strong>{skipped}</strong>Ignorados</div>
        </div>
        <p role="status">{connection || (job?.status === 'completed' ? (files.length ? 'Migração concluída.' : 'Pasta de origem sem arquivos.')
          : running ? (files.length ? 'Transferindo arquivos…' : 'Preparando migração…') : '')}</p>
        {job?.message && <p className="alert" role="alert">{job.message}</p>}
        <h3>Log de transferências</h3>
        {files.length ? <div className="table-wrap"><table><thead><tr><th>Arquivo</th><th>Blob de destino</th><th>Status</th><th>Duração</th><th>Detalhes</th></tr></thead>
          <tbody>{files.map(file => <tr key={file.id}><td>{file.path}</td><td>{file.blobName}</td>
            <td><span className={'status ' + file.status}>{labels[file.status]}</span></td>
            <td>{file.durationMs === undefined ? '—' : (file.durationMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' s'}</td>
            <td>{file.status === 'success' && !deleted.has(file.blobName) ? <BlobActions name={file.blobName} token={token} /> : file.message ?? '—'}</td></tr>)}</tbody></table></div>
          : <p className="empty">Nenhuma transferência registrada.</p>}
      </section>
    </main>
  </>;
}

function Listing({ rows, busy, error, actions, selection }: { rows?: React.ReactNode[]; busy: boolean; error: string; actions?: boolean; selection?: boolean }) {
  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    {rows?.length ? <div className="table-wrap"><table><thead><tr>{selection && <th>Selecionar</th>}<th>Nome</th><th>Tamanho</th><th>Modificação</th>{actions && <th>Ações</th>}</tr></thead>
      <tbody>{rows}</tbody></table></div> : <p className="empty" role="status">{busy ? 'Consultando arquivos…' : rows ? 'Nenhum arquivo encontrado.' : 'Consulta ainda não realizada.'}</p>}
  </>;
}

function BlobActions({ name, token, onDelete, blockDelete }: {
  name: string; token: string; onDelete?: (name: string) => void; blockDelete?: boolean
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; type: string; text?: string }>();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!preview) return;
    dialog.current?.showModal();
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function act(action: 'Baixar' | 'Visualizar' | 'Excluir') {
    if (action === 'Excluir' && !window.confirm(`Excluir “${name}” do Azure Blob Storage?`)) return;
    setBusy(action);
    setError('');
    try {
      const query = new URLSearchParams({ name });
      if (action === 'Excluir') {
        await request('/azure/blobs?' + query, token, { method: 'DELETE' });
        onDelete?.(name);
        return;
      }
      if (action === 'Visualizar') query.set('preview', '1');
      const response = await request('/azure/blobs/download?' + query, token);
      const data = await response.blob();
      const url = URL.createObjectURL(data);
      if (action === 'Visualizar') {
        setPreview({ url, type: data.type, text: data.type.startsWith('text/plain') ? await data.text() : undefined });
        return;
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = name.split('/').at(-1) || 'arquivo';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy('');
    }
  }

  return <>
    <div className="blob-actions" aria-busy={!!busy}>
      <button type="button" disabled={!token || !!busy} onClick={() => act('Visualizar')}>Visualizar</button>
      <button type="button" disabled={!token || !!busy} onClick={() => act('Baixar')}>Baixar</button>
      {onDelete && <button className="danger" type="button" disabled={!token || !!busy || blockDelete}
        onClick={() => act('Excluir')}>Excluir</button>}
    </div>
    {busy && <small role="status">{busy}…</small>}
    {error && <p className="alert" role="alert">{error}</p>}
    {preview && <dialog ref={dialog} className="blob-preview" aria-label={name} onClose={() => setPreview(undefined)}>
      <div className="heading"><h3>{name}</h3><button type="button" onClick={() => dialog.current?.close()}>Fechar</button></div>
      {preview.text !== undefined ? <pre>{preview.text}</pre> : preview.type.startsWith('image/')
        ? <img src={preview.url} alt={name} /> : preview.type === 'application/pdf' && <iframe title={name} src={preview.url} />}
    </dialog>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
