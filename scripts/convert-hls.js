// videos/ 폴더의 mp4를 HLS로 변환합니다 (360p, 720p 두 화질, 4초 단위 조각).
// 사용법: npm run hls              (videos/ 안의 모든 영상)
//        npm run hls -- sample.mp4 (특정 영상만)
//
// 결과 구조:
//   hls/sample/master.m3u8        ← 화질 목록 (플레이어가 가장 먼저 받는 파일)
//   hls/sample/360p/index.m3u8    ← 360p 조각 목록
//   hls/sample/360p/seg_000.ts    ← 실제 영상 조각 (4초)
//   hls/sample/720p/...
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'videos');
const HLS_DIR = path.join(ROOT, 'hls');
const SEGMENT_SECONDS = 4;

function hasAudio(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  return r.stdout.trim().length > 0;
}

function convert(fileName) {
  const input = path.join(VIDEO_DIR, fileName);
  const name = path.parse(fileName).name;
  const outDir = path.join(HLS_DIR, name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const audio = hasAudio(input);

  const args = [
    '-y', '-i', input,
    // 영상 하나를 둘로 복제해서 각각 다른 해상도로 축소
    '-filter_complex', '[0:v]split=2[a][b];[a]scale=-2:360[v360];[b]scale=-2:720[v720]',
    '-map', '[v360]', '-map', '[v720]',
    ...(audio ? ['-map', '0:a', '-map', '0:a'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v:0', '800k', '-maxrate:v:0', '900k', '-bufsize:v:0', '1600k',
    '-b:v:1', '2800k', '-maxrate:v:1', '3000k', '-bufsize:v:1', '5600k',
    // 조각 경계마다 키프레임을 강제로 넣어야 조각을 독립적으로 재생하거나 화질을 바꿀 수 있습니다.
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-sc_threshold', '0',
    ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    // 출력 경로는 상대경로 + "/"로 지정합니다 (Windows의 "\"가 재생목록 URL에 들어가지 않게).
    '-hls_segment_filename', '%v/seg_%03d.ts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', audio ? 'v:0,a:0,name:360p v:1,a:1,name:720p' : 'v:0,name:360p v:1,name:720p',
    '%v/index.m3u8',
  ];

  console.log(`\n[${fileName}] HLS 변환 중... (오디오: ${audio ? '있음' : '없음'})`);
  const r = spawnSync('ffmpeg', args, { cwd: outDir, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stderr.split('\n').slice(-15).join('\n'));
  if (r.status !== 0) {
    console.error(`[${fileName}] 변환 실패`);
    return false;
  }
  const segs = fs.readdirSync(path.join(outDir, '720p')).filter((f) => f.endsWith('.ts')).length;
  console.log(`[${fileName}] 완료 → hls/${name}/master.m3u8 (화질별 조각 ${segs}개)`);
  return true;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (fs.existsSync(VIDEO_DIR) ? fs.readdirSync(VIDEO_DIR) : []).filter((f) => /\.(mp4|webm|mov|mkv)$/i.test(f));

if (targets.length === 0) {
  console.log('변환할 영상이 없습니다. videos/ 폴더에 영상을 넣거나 "npm run sample"을 먼저 실행하세요.');
  process.exit(0);
}
let ok = true;
for (const t of targets) ok = convert(t) && ok;
process.exit(ok ? 0 : 1);
