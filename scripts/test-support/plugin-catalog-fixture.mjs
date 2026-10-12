import http from 'node:http';

const CATALOG_HOST = 'plugins.example.test';
const LOOPBACK_HOST = '127.0.0.1';

export async function createPluginCatalogFixture({ getCatalog, packages = new Map() } = {}) {
  if (typeof getCatalog !== 'function') throw new TypeError('getCatalog must be a function');
  const packageEntries = packages instanceof Map ? [...packages.entries()] : Object.entries(packages);
  const packageBytes = new Map(packageEntries.map(([pathname, bytes]) => {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('..')) {
      throw new TypeError('package paths must be absolute fixture paths');
    }
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
      throw new TypeError('package bodies must be byte arrays');
    }
    return [pathname, Buffer.from(bytes)];
  }));
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://' + LOOPBACK_HOST).pathname;
    requests.push({ method: request.method || '', path: pathname });
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    if (pathname === '/catalog.json') {
      let body;
      try {
        body = Buffer.from(JSON.stringify(getCatalog()), 'utf8');
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('fixture catalog provider failed: ' + String(error?.message ?? error));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength)
      });
      response.end(body);
      return;
    }
    const body = packageBytes.get(pathname);
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('fixture resource not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength)
    });
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_HOST);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    throw new Error('Plugin Catalog fixture did not receive a TCP address');
  }
  const loopbackOrigin = 'http://' + LOOPBACK_HOST + ':' + address.port;
  const catalogUrl = 'https://' + CATALOG_HOST + '/catalog.json';
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  return Object.freeze({
    catalogUrl,
    allowedHosts: Object.freeze([CATALOG_HOST]),
    loopbackOrigin,
    requests,
    close
  });
}