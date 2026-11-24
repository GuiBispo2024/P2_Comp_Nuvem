const backendUrl = process.env.BACKEND_ORIGIN?.trim();
let rewrites: { source: string; destination: string }[] = [];

if (backendUrl) {
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'https:' || backend.username || backend.password
    || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('BACKEND_ORIGIN deve ser uma origem HTTPS sem caminho, credenciais ou parâmetros.');
  }
  rewrites = [{
    source: '/api/:path*',
    destination: backend.origin + '/api/:path*'
  }];
}

export const config = {
  framework: 'vite',
  buildCommand: 'npm run build',
  outputDirectory: 'frontend/dist',
  rewrites
};
