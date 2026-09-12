// 精力助手 · 极简本地服务（纯 Node 内置模块，零依赖）
// 作用：让工具跑在 localhost 上，从而能自动读取 inbox/tasks.json（file:// 下无法 fetch）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const HOST = '127.0.0.1';
const PREFERRED_PORT = 8642;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 应用只需这几个文件：白名单既防目录穿越，也避免把 CLAUDE.md / 启动.bat / .claude 等暴露到 localhost
const ALLOWED = new Set(['/index.html', '/styles.css', '/app.js', '/inbox/tasks.json']);

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://' + HOST).pathname);
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (!ALLOWED.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  fs.readFile(path.join(ROOT, urlPath), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(urlPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function openBrowser(url) {
  // Windows：start "" "url" 用默认浏览器打开
  exec('start "" "' + url + '"', (e) => {
    if (e) console.log('无法自动打开浏览器，请手动访问：' + url);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !server._fallback) {
    server._fallback = true;
    console.log('端口 ' + PREFERRED_PORT + ' 被占用，改用随机端口…');
    server.listen(0, HOST); // 随机可用端口
  } else {
    throw err;
  }
});

server.on('listening', () => {
  const actual = server.address().port;
  const url = 'http://localhost:' + actual;
  console.log('🧠 精力助手已启动：' + url);
  console.log('  按 Ctrl+C 停止服务');
  openBrowser(url);
});

server.listen(PREFERRED_PORT, HOST);
