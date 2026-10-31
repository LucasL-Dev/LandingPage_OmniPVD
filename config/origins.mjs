export const DEFAULT_SITE_ORIGIN = 'https://omnipdv.com.br';
export const DEFAULT_API_ORIGIN = 'https://api.omnipdv.com.br';

// No origin reflection. HTTP is accepted only for explicit loopback development.
export function validateOrigin(value, name) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} deve ser uma origem HTTPS sem caminho, credenciais ou barra final.`);
  }
  return url.origin;
}
export function deploymentOrigins(env = process.env) {
  return {
    site: validateOrigin(env.SITE_ORIGIN || env.DOMAIN || DEFAULT_SITE_ORIGIN, 'SITE_ORIGIN'),
    api: validateOrigin(env.API_ORIGIN || DEFAULT_API_ORIGIN, 'API_ORIGIN'),
  };
}
