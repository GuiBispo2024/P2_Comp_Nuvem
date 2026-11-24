import 'dotenv/config';
import { createApp } from './app.ts';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
  console.error('PORT deve ser um inteiro entre 1 e 65535.');
  process.exit(1);
}

const server = createApp().listen(port, '0.0.0.0', () => console.info(`Servidor iniciado na porta ${port}.`));
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Porta ${port} já está em uso. Encerre o outro processo ou ajuste PORT.`
    : `Falha ao iniciar o servidor na porta ${port} (${error.code ?? 'erro desconhecido'}).`);
  process.exit(1);
});
