// ffmpeg로 테스트용 영상(화면에 시간이 표시되는 60초짜리 720p 영상)을 만듭니다.
// 사용법: npm run sample
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'videos', 'sample.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });

const args = [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', // 시간 카운터가 있는 테스트 화면
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', // 삐 소리
  '-t', '60',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '3M',
  '-c:a', 'aac', '-b:a', '128k',
  // moov(메타데이터) 정보를 파일 앞쪽에 둡니다.
  // 이게 뒤에 있으면 브라우저가 파일 끝부분부터 먼저 받아야 재생을 시작할 수 있습니다.
  '-movflags', '+faststart',
  out,
];

console.log('테스트 영상 생성 중...');
const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) process.exit(r.status || 1);
console.log(`완료: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB)`);
