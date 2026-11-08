// 공부용 동영상 스트리밍 서버 (외부 패키지 없음, Node 기본 모듈만 사용)
//
//  1) /video/<파일명>     : HTTP Range 요청 방식 (mp4 하나를 바이트 범위로 잘라 전송)
//  2) /hls/<이름>/...     : HLS 방식 (미리 잘라 둔 .ts 조각 + .m3u8 재생목록 전송)
//  3) /events            : 서버 로그를 브라우저로 실시간 전송 (SSE)
//  4) /api/throttle      : 전송 속도 제한 (느린 네트워크 흉내 → 버퍼링/화질 전환 관찰용)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const VIDEO_DIR = path.join(ROOT, 'videos');
const HLS_DIR = path.join(ROOT, 'hls');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Range 방식에서 한 번에 보내는 최대 크기.
// 브라우저는 보통 "bytes=0-"(끝까지 전부 달라)처럼 요청하지만,
// 서버가 일부만 잘라 보내도 됩니다. 그러면 브라우저가 다음 범위를 다시 요청합니다.
// → 조각 단위로 오가는 모습을 로그에서 볼 수 있게 1MB로 제한했습니다.
const CHUNK_SIZE = 1 * 1024 * 1024;

// 전송 속도 제한 (KB/s, 0 = 제한 없음)
let throttleKBps = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

// ───────────────────────── 로그 (콘솔 + SSE) ─────────────────────────
const sseClients = new Set();

function log(type, message) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] [${type}] ${message}`);
  const data = JSON.stringify({ time, type, message });
  for (const res of sseClients) res.write(`data: ${data}\n\n`);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

// ───────────────────────── 유틸 ─────────────────────────
// base 폴더 밖으로 나가는 경로(../ 등)를 막습니다.
function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const full = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// 파일 스트림을 응답으로 흘려보냅니다. 속도 제한이 켜져 있으면 천천히 보냅니다.
async function pipeWithThrottle(stream, res) {
  res.on('close', () => stream.destroy()); // 클라이언트가 중간에 끊으면 읽기도 중단
  try {
    for await (const chunk of stream) {
      if (res.destroyed) break;
      if (!res.write(chunk)) {
        await new Promise((r) => res.once('drain', r));
      }
      if (throttleKBps > 0) {
        const ms = (chunk.length / (throttleKBps * 1024)) * 1000;
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ───────────────────────── 1) Range 방식 ─────────────────────────
function handleRangeVideo(req, res, fileName) {
  const filePath = safeJoin(VIDEO_DIR, fileName);
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const fileSize = fs.statSync(filePath).size;
  const range = req.headers.range; // 예: "bytes=0-" 또는 "bytes=1048576-2097151"
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  if (!range) {
    // Range 헤더가 없으면 파일 전체를 200으로 보냅니다 (일반 다운로드와 같음).
    log('RANGE', `${fileName}  Range 헤더 없음 → 200 전체 전송 (${fmtBytes(fileSize)})`);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes', // "이 서버는 범위 요청을 지원합니다"
    });
    return pipeWithThrottle(fs.createReadStream(filePath), res);
  }

  // "bytes=start-end" 파싱
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start, end;
  if (match && match[1] === '' && match[2] !== '') {
    // "bytes=-500" → 마지막 500바이트
    start = Math.max(fileSize - Number(match[2]), 0);
    end = fileSize - 1;
  } else if (match) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : fileSize - 1;
  }

  if (!match || isNaN(start) || start >= fileSize || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); // 범위가 잘못됨
    return res.end();
  }

  // 한 번에 CHUNK_SIZE까지만 보냅니다.
  end = Math.min(end, start + CHUNK_SIZE - 1, fileSize - 1);
  const length = end - start + 1;
  const pct = ((end + 1) / fileSize * 100).toFixed(1);

  log('RANGE', `${fileName}  요청 "${range}" → 206 bytes ${start}-${end} (${fmtBytes(length)}, 파일의 ${pct}%까지)`);

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': length,
    'Content-Range': `bytes ${start}-${end}/${fileSize}`, // 이번에 보내는 위치 / 전체 크기
    'Accept-Ranges': 'bytes',
  });
  pipeWithThrottle(fs.createReadStream(filePath, { start, end }), res);
}

// ───────────────────────── 2) HLS 방식 ─────────────────────────
function handleHls(req, res, subPath) {
  const filePath = safeJoin(HLS_DIR, subPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const size = fs.statSync(filePath).size;

  if (ext === '.m3u8') {
    const isMaster = path.basename(filePath) === 'master.m3u8';
    log('HLS', `${subPath}  ← ${isMaster ? '마스터 재생목록 (화질 목록)' : '미디어 재생목록 (조각 목록)'}`);
  } else {
    log('HLS', `${subPath}  ← 영상 조각 (${fmtBytes(size)})`);
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-cache',
  });
  pipeWithThrottle(fs.createReadStream(filePath), res);
}

// ───────────────────────── API ─────────────────────────
function listVideos() {
  const exts = ['.mp4', '.webm'];
  const files = fs.existsSync(VIDEO_DIR) ? fs.readdirSync(VIDEO_DIR) : [];
  return files
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const name = path.parse(f).name;
      return {
        file: f,
        size: fs.statSync(path.join(VIDEO_DIR, f)).size,
        hls: fs.existsSync(path.join(HLS_DIR, name, 'master.m3u8')) ? `/hls/${name}/master.m3u8` : null,
      };
    });
}

// ───────────────────────── 라우팅 ─────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/videos') return sendJson(res, listVideos());

  if (p === '/api/throttle') {
    if (req.method === 'POST') {
      const v = Number(url.searchParams.get('kbps'));
      throttleKBps = Number.isFinite(v) && v > 0 ? v : 0;
      log('SERVER', throttleKBps ? `속도 제한: ${throttleKBps} KB/s` : '속도 제한 해제');
    }
    return sendJson(res, { kbps: throttleKBps });
  }

  if (p.startsWith('/video/')) return handleRangeVideo(req, res, p.slice('/video/'.length));
  if (p.startsWith('/hls/')) return handleHls(req, res, p.slice('/hls/'.length));

  // 정적 파일 (public/)
  const filePath = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  스트리밍 서버 실행 중 → http://localhost:${PORT}\n`);
  const vids = listVideos();
  if (vids.length === 0) {
    console.log('  videos/ 폴더에 영상이 없습니다. "npm run sample"로 테스트 영상을 만드세요.\n');
  } else {
    for (const v of vids) console.log(`  - ${v.file} (${fmtBytes(v.size)}) HLS: ${v.hls ? '있음' : '없음 → npm run hls'}`);
    console.log();
  }
});
