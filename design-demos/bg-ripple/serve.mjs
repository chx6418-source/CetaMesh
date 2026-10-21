// 湖面涟漪渐变背景 · 预览服务器（仅本机）
// 用法：node design-demos/bg-ripple/serve.mjs → http://127.0.0.1:4175/
//   静态根只暴露本目录（不是仓库根）：另有 /public/token-login.html 一条显式白名单路由，
//   用来在本机预览「融合后的登录页」，不必把整个仓库根（含 config.json / state/）挂成静态目录。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const DEFAULT_ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = process.env.ROOT ? normalize(process.env.ROOT) : DEFAULT_ROOT;
const REPO = normalize(join(ROOT, '..', '..'));
const EXTRA = {
  // 只放行这两个生产页面（控制台需要 /api，静态服务下只能看版面与落场背景）
  '/public/token-login.html': join(REPO, 'public', 'token-login.html'),
  '/public/console.html': join(REPO, 'public', 'console.html')
};
const PORT = Number(process.env.PORT || 4175);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.json': 'application/json; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = EXTRA[p] || normalize(join(ROOT, p));
    if (!EXTRA[p] && !file.startsWith(normalize(ROOT))) throw new Error('forbidden');
    const info = await stat(file);
    const buf = await readFile(file);
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
      const start = Number(startRaw) || 0;
      const end = endRaw ? Number(endRaw) : info.size - 1;
      res.writeHead(206, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes', 'content-length': end - start + 1
      });
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': buf.length, 'cache-control': 'no-store',
      'access-control-allow-origin': '*'   // 便于本机跨端口做像素比对（对照基准图）
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`bg-ripple preview -> http://127.0.0.1:${PORT}/`));
