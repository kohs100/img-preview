# img-preview

패턴 템플릿으로 생성한 다수의 이미지 URL을 미리 볼 수 있는 브라우저 UI를 갖춘
**이미지 캐싱 프록시**입니다. origin에서 이미지를 받아오고(호스트별 rate-limit),
PNG는 WebP로 변환한 뒤 캐시에 저장합니다. 캐시는 **로컬 파일시스템** 또는 임의의
**S3 호환** 오브젝트 스토리지에 저장할 수 있으며, 둘 사이를 **양방향으로 마이그레이션**할
수 있습니다.

## 동작 개요

1. **프론트엔드** (`public/`) — `캐릭터`, `의상`, `상황` 토큰 목록과
   `https://cdn.example.com/캐릭터_의상_상황.png` 같은 URL 템플릿을 입력하는 단일
   페이지입니다. 토큰은 범위(`1..4`)와 leading-zero 패딩을 지원하며, 범위 시작값에
   prefix를 붙일 수도 있습니다(`a1..3` → `a1,a2,a3`). 페이지는 템플릿을 이미지 URL
   그리드로 확장하고, 각 이미지를 캐시 엔드포인트로 지연 로딩하면서 아직 가져오는
   중이면 폴링합니다.
2. **백엔드** (`src/`) — 캐시된 이미지를 서빙하고, 미스 발생 시 on-demand로 origin에서
   받아와 설정된 스토리지 백엔드에 저장하는 Express 서버입니다.

```
브라우저 ──/cached/<origin-url>──▶ Express ──▶ CacheManager (메모리 인덱스)
                                     │                │
                                     ▼                ▼
                              DownloadManager    ObjectStorage 백엔드
                              (fetch + 변환)      (fs  |  s3)
```

## HTTP API (프론트엔드 계약 — 변경 없음)

| 메서드 & 경로                        | 동작 |
| ----------------------------------- | ---- |
| `GET /`                             | `/static`로 302 리다이렉트 |
| `GET /static/*`                     | 정적 프론트엔드 자산 |
| `GET /cached/:imageUrl(*)?referrer=` | 캐시 적중 시 `200` + 이미지 바이트, 가져오는 중이면 `503 Processing`(첫 미스에서 fetch 시작), 실패 시 origin 에러 상태 |
| `GET /refresh/:imageUrl(*)?referrer=` | 강제 재fetch 후 `503 Processing` 반환 |
| `POST /api/submissions`             | `204`; 프론트엔드 폼 제출을 로깅 |

`:imageUrl`은 origin URL입니다. route가 `(*)` 와일드카드라 슬래시 포함 경로를 그대로
받고, 서버의 `normalizeUrl`이 scheme이 없으면 `https://`를 보충합니다. 따라서
프론트엔드는 scheme(`https://`)을 떼고 인코딩 없이 그대로 이어 붙입니다 — 예:
`/cached/cdn.example.com/char/1.png?referrer=...`. (scheme을 포함하거나 percent-encode된
형태도 서버가 그대로 허용하므로 계약은 하위 호환입니다.) 캐시 키는 origin URL에서
query/hash를 제거한 것이며, 스토리지 백엔드를 바꿔도 이 계약은 동일합니다 — 바이트가
어디에 저장되는지만 달라집니다.

> 단순화 trade-off: 이 raw 방식은 영숫자·`/`·`.`·`_`·`$` 같은 일반적인 CDN 경로에서
> 안전합니다. 다만 origin 경로에 `#`(브라우저가 fragment로 처리해 서버로 전송 안 됨),
> 리터럴 `%`(잘못된 percent-encoding으로 해석될 수 있음), 공백/비-ASCII 등이 들어가면
> 깨질 수 있으니 그런 경우엔 `encodeURIComponent`가 필요합니다.

## 스토리지 아키텍처

모든 이미지 바이트는 백엔드와 무관한 **key**(예:
`processed/cdn.example.com/char/1.webp` 형태의 POSIX 상대 경로)로 식별됩니다. 어떤
백엔드를 쓰든 동일한 key 집합을 사용하므로, 마이그레이션은 key를 그대로 복사하는
작업이 됩니다.

- `source/<host>/<path>` — 다운로드한 원본 바이트.
- `processed/<host>/<path>` — 서빙되는 오브젝트(PNG 입력은 WebP, 그 외에는 원본과 동일).
- `<key>.meta.json` — `{ url, key, contentType, updatedAt }`을 담는 사이드카.
  서버는 시작 시 이 사이드카들을 나열해 메모리 인덱스를 복원하므로 재시작 후에도
  캐시가 유지됩니다.

`ObjectStorage` 인터페이스(`src/storage/types.ts`)에는 두 가지 구현이 있습니다.

- **`FsStorage`** — 베이스 디렉터리 하위 파일(`src/storage/fs-storage.ts`).
- **`S3Storage`** — AWS SDK v3를 통한 AWS S3 / MinIO / Cloudflare R2 / Backblaze B2 등
  (`src/storage/s3-storage.ts`).

백엔드는 런타임에 환경 변수로 선택되며, 앱의 나머지 부분은 `ObjectStorage`
인터페이스만 봅니다.

## 환경 변수

| 변수                       | 기본값      | 설명 |
| ------------------------- | ----------- | ---- |
| `PORT`                    | `3013`      | HTTP 포트 |
| `ORIGIN_MIN_INTERVAL_MS`  | `200`       | 동일 origin 호스트로의 요청 간 최소 간격 |
| `CACHE_BACKEND`           | `fs`        | `fs` 또는 `s3` |
| `CACHE_DIR`               | `cache`     | `fs` 백엔드의 베이스 디렉터리 |
| `S3_BUCKET`               | —           | 버킷 이름 (`s3`에서 필수) |
| `S3_REGION`               | `us-east-1` | 리전 |
| `S3_ENDPOINT`             | —           | S3 호환 서버의 커스텀 엔드포인트 (예: `http://localhost:9000`) |
| `S3_ACCESS_KEY_ID`        | —           | 미설정 시 기본 AWS 자격증명 체인 사용 |
| `S3_SECRET_ACCESS_KEY`    | —           | — |
| `S3_FORCE_PATH_STYLE`     | `true`      | path-style 주소 방식 (대부분의 비-AWS 서버에 필요) |
| `S3_PREFIX`               | —           | 여러 배포가 한 버킷을 공유할 수 있게 하는 key prefix |

## 실행

```bash
npm install

# 로컬 파일시스템 캐시 (기본값)
npm run dev                 # watch 모드 (tsx)
npm run build && npm start  # 컴파일 (dist/)

# S3 호환 캐시
CACHE_BACKEND=s3 \
S3_BUCKET=img-cache \
S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY_ID=key S3_SECRET_ACCESS_KEY=secret \
npm start
```

`http://localhost:3013/` 접속.

## 백엔드 간 마이그레이션

`npm run migrate -- <from> <to>`는 모든 오브젝트(이미지 + meta 사이드카)를 한 백엔드에서
다른 백엔드로 복사합니다. `fs` 쪽은 `CACHE_DIR`, `s3` 쪽은 `S3_*` 변수로 설정됩니다.

```bash
# 파일시스템 ➜ S3
S3_BUCKET=img-cache S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY_ID=key S3_SECRET_ACCESS_KEY=secret \
npm run migrate -- fs s3

# S3 ➜ 파일시스템
S3_BUCKET=img-cache S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY_ID=key S3_SECRET_ACCESS_KEY=secret \
npm run migrate -- s3 fs
```

플래그:

| 플래그                | 설명 |
| -------------------- | ---- |
| `--prefix <key>`     | 해당 prefix로 시작하는 key만 마이그레이션 |
| `--overwrite`        | 대상에 이미 존재하는 오브젝트를 덮어씀 (기본: 건너뜀) |
| `--dry-run`          | 쓰기 없이 나열/카운트만 수행 |
| `--concurrency <n>`  | 배치당 병렬 복사 수 (기본 `8`) |

마이그레이션은 멱등적입니다 — 재실행하면 `--overwrite`가 없는 한 대상에 이미 존재하는
오브젝트를 건너뜁니다. key가 백엔드 간 동일하므로, 마이그레이션된 캐시는 별도의
재인덱싱 없이 그대로 서빙됩니다 — 서버가 다음 시작 시 복사된 `.meta.json` 사이드카로
인덱스를 복원합니다.

## 프로젝트 구조

```
src/
  server.ts            Express 앱 + 라우트 (프론트엔드 계약)
  cache-manager.ts     메모리 인덱스 + .meta.json 영속화/복원
  download-manager.ts  origin fetch, 호스트별 throttle, PNG→WebP 변환
  migrate.ts           fs <-> s3 마이그레이션 CLI
  storage/
    types.ts           ObjectStorage 인터페이스 + 백엔드 설정 타입
    fs-storage.ts      파일시스템 백엔드
    s3-storage.ts      S3 호환 백엔드
    factory.ts         환경 변수 기반 백엔드 선택
    index.ts           배럴 익스포트
public/                정적 프론트엔드 (index.html, script.js, style.css)
```
