# 공부용 동영상 스트리밍 서버

외부 패키지 없이 Node.js 기본 모듈과 ffmpeg만으로 만든 스트리밍 서버입니다.
두 가지 방식을 나란히 돌려 보며 비교할 수 있습니다.

## 실행

```bash
npm run setup   # 테스트 영상 생성(videos/sample.mp4) + HLS 변환(hls/sample/)
npm start       # http://localhost:3000
```

내 영상을 쓰려면 `videos/`에 mp4를 넣고 `npm run hls`를 실행하세요.

## 방식 ① HTTP Range (점진적 다운로드)

```
브라우저                                   서버
  │ GET /video/sample.mp4                   │
  │ Range: bytes=0-                ───────▶ │
  │ ◀─────── 206 Partial Content            │
  │          Content-Range: bytes 0-1048575/23527779
  │ Range: bytes=1048576-          ───────▶ │  (다음 조각)
  │ ...                                     │
  │ (사용자가 재생 바를 40초로 이동)        │
  │ Range: bytes=15600000-         ───────▶ │  (해당 위치로 바로 점프)
```

- 파일은 **하나**입니다. 브라우저가 필요한 **바이트 범위**만 요청합니다.
- `<video src="...">`만 써도 브라우저가 Range 요청을 알아서 보냅니다.
- mp4의 `moov`(목차 정보)가 파일 앞에 있어야 바로 재생됩니다 (`-movflags +faststart`).
- **한계**: 화질이 하나로 고정됩니다. 네트워크가 느려지면 화질을 낮추지 못하고 멈춥니다.
- 코드: `server.js`의 `handleRangeVideo`

## 방식 ② HLS (조각 + 재생목록)

```
hls/sample/
├── master.m3u8          ← 1. 화질 목록 (360p는 1Mbps, 720p는 3Mbps)
├── 360p/
│   ├── index.m3u8       ← 2. 조각 목록 (seg_000.ts 4초, seg_001.ts 4초, ...)
│   └── seg_000.ts ...   ← 3. 실제 영상 조각
└── 720p/ ...
```

1. 플레이어가 `master.m3u8`을 받아 어떤 화질이 있는지 확인합니다.
2. 네트워크 속도를 보고 화질을 골라 `index.m3u8`을 받습니다.
3. 조각(`.ts`)을 순서대로 받으면서 **다운로드 속도를 계속 측정**합니다.
4. 느려지면 다음 조각부터 낮은 화질 폴더에서 받습니다. 이를 **ABR(Adaptive Bitrate)**이라 합니다.

- 화질을 바꿀 수 있는 이유: 모든 화질의 조각 경계가 같은 시각에 있고, 각 조각이 키프레임으로 시작합니다 (`-force_key_frames`).
- 서버는 그냥 **정적 파일 서버**입니다. 똑똑한 일은 플레이어(hls.js)가 합니다. 그래서 CDN에 올려 대규모로 배포하기 쉽습니다.
- Chrome은 HLS를 직접 재생하지 못합니다. hls.js가 조각을 받아 MSE(Media Source Extensions)로 `<video>`에 넣어 줍니다. Safari는 기본 지원합니다.
- 코드: `scripts/convert-hls.js`(자르기), `server.js`의 `handleHls`(전송)

## 해 볼 실험

| 실험 | 관찰 포인트 |
|---|---|
| Range 모드에서 재생 바를 뒤로 건너뛰기 | 로그의 `bytes` 시작 위치가 갑자기 커짐 |
| Range 모드 + 속도 100KB/s | 화질을 못 낮추니 버퍼링으로 멈춤 |
| HLS 모드 + 속도 250KB/s | `[PLAYER] 화질 전환 → 360p`, 이후 `360p/seg_xxx.ts` 요청 |
| HLS 모드 + 제한 해제 | 다시 720p로 올라감 |
| 브라우저 개발자도구 → Network 탭 | 요청/응답 헤더 직접 확인 |
| `hls/sample/720p/index.m3u8`을 메모장으로 열기 | 재생목록은 그냥 텍스트 파일 |

## 파일 구조

```
server.js                서버 (Range, HLS, SSE 로그, 속도 제한)
public/index.html        실습 페이지 (플레이어 + 버퍼 시각화 + 실시간 로그)
scripts/make-sample.js   테스트 영상 생성
scripts/convert-hls.js   mp4 → HLS 변환 (360p/720p, 4초 조각)
```
