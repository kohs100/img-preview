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
   중이면 폴링합니다. 메인 목록의 **Download All**은 `mode=download` 페이지로 이동해 모든
   `캐릭터×의상×상황` 조합을 서버에 캐시하도록 요청하고, 이미지를 내려받지 않은 채 각
   조합의 상태(대기·진행률·완료·실패)만 그리드로 보여줍니다. 실패한 항목은 `/refresh`로 다시
   시도할 수 있습니다.
2. **백엔드** (`src/`) — 캐시된 이미지를 서빙하고, 미스 발생 시 on-demand로 origin에서
   받아와 설정된 스토리지 백엔드에 저장하는 Express 서버입니다.

```
브라우저 ──/cached/<origin-url>──▶ Express ──▶ CacheManager (메모리 인덱스)
                                     │                │
                                     ▼                ▼
                              DownloadManager    ObjectStorage 백엔드
                              (fetch + 변환)      (fs  |  s3)
```

## HTTP API

| 메서드 & 경로                        | 동작 |
| ----------------------------------- | ---- |
| `GET /`                             | `/static`로 302 리다이렉트 |
| `GET /static/*`                     | 정적 프론트엔드 자산 |
| `GET /cached/:imageUrl(*)?referrer=` | 캐시 적중 시 `200`; 처리 중이면 phase와 byte 진행도를 담은 `503` JSON, 실패 시 origin 에러 상태 |
| `GET /refresh/:imageUrl(*)?referrer=` | 강제 재fetch 후 처리 상태 `503` JSON 반환 |
| `POST /api/submissions`             | `204`; 프론트엔드 폼 제출을 로깅 |
| `POST /api/cache-status`            | `{ urls, referrer }`(최대 500개)를 받아 캐시되지 않은 URL의 fetch를 시작하고, 입력 순서대로 `{ results: [{ status, phase, percent?, errorStatusCode?, message? }] }` 반환. 이미지 바이트는 보내지 않음 |
| `GET /api/proxies`                  | 다운로드 경로(direct + 프록시)별 설정·health·외부 IP·사용 여부·통계 |
| `GET /api/storage/endpoints`        | presigned URL에 쓸 수 있는 endpoint 목록(`S3_BROWSER_ENDPOINT` 항목들 + `direct` = `S3_ENDPOINT`), 기본값, 선택 가능 여부. `/cached?endpoint=<id>`로 지정 |
| `POST /api/proxies/check`           | `proxy.json`을 다시 읽고 전체 경로를 검사한 뒤 상태 반환. `{ ids: [...] }`면 해당 경로만 검사 |
| `PATCH /api/proxies/:id`            | `{ enabled?, concurrency? }` 변경 후 상태 반환. `proxy-settings.json`에 저장 |

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

`/api/cache-status`의 `urls`는 `/cached` 경로와 같은 형식(scheme 생략 가능, query/hash
무시, percent-decode)으로 해석되므로 같은 캐시 key를 공유합니다.

처리 중 응답 예시입니다. `Content-Length`를 제공하지 않는 origin이나 Sharp 변환,
암호화·업로드·index 단계는 정확한 퍼센트 없이 phase만 반환합니다.

```json
{
  "status": "processing",
  "phase": "downloading",
  "completedBytes": 524288,
  "totalBytes": 2097152,
  "percent": 25
}
```

phase는 `queued`, `downloading`, `transforming`, `encrypting`, `uploading`, `indexing`
순으로 진행됩니다. 브라우저 카드는 이후 S3 암호문 전송의 실제 byte 진행도와
`decrypting` 상태도 별도로 표시합니다.

## 다운로드 경로 (프록시)

origin 다운로드는 서버 자체 연결(`direct`)과 `proxy.json`의 프록시들에 나눠 보냅니다.
동시 다운로드 수 제한과 요청 간격은 **경로마다 따로** 적용되므로, 외부 IP가 다른 경로를
추가할수록 IP 하나가 origin에 주는 부하는 그대로 두고 전체 병렬도만 늘어납니다.

```json
{
  "tokyo": { "type": "SOCKS5", "hostname": "10.0.0.5", "port": 1080, "region": "jp", "auth": null },
  "seoul": { "type": "SOCKS5", "hostname": "10.0.0.6", "port": 1080, "region": "kr",
             "auth": { "id": "user", "password": "secret" } }
}
```

- `type`은 `SOCKS5`, `SOCKS4`를 지원합니다. 목적지 DNS는 프록시에서 resolve됩니다.
- 시작 시와 `PROXY_CHECK_INTERVAL_MS`마다 각 경로로 `PROXY_IP_CHECK_URL`을 요청해 동작
  여부와 외부 IP를 확인합니다. 검사를 통과한 프록시만 사용하며, direct는 검사 결과와
  무관하게 사용합니다.
- 외부 IP가 같은 경로는 한 그룹으로 묶어 하나만 사용합니다(direct 우선, 그다음 지연시간이
  짧은 순).
- 다운로드 중 프록시 연결이 연속 3번 실패하면 그 프록시를 제외하고, 실패한 요청은 다른
  경로로 재시도합니다. 다음 검사를 통과하면 다시 사용합니다.
- `/static/proxies.html`(메인 페이지의 *Download routes*)에서 상태를 보고, 경로별
  사용 여부와 동시 다운로드 수를 바꾸거나 `proxy.json`을 다시 읽어 재검사할 수 있습니다.
  설정은 `proxy-settings.json`에 저장되고 `proxy.json`은 수정하지 않습니다.
- 두 파일은 `.gitignore`에 포함되어 있습니다. 설정 API에는 인증이 없으므로 서버를 외부에
  공개할 때는 앞단에서 접근을 제한해야 합니다.

## 스토리지 아키텍처

모든 이미지 바이트는 백엔드와 무관한 **key**(예:
`processed/cdn.example.com/char/1.webp` 형태의 POSIX 상대 경로)로 식별됩니다. 어떤
백엔드를 쓰든 동일한 key 집합을 사용하므로, 마이그레이션은 key를 그대로 복사하는
작업이 됩니다.

- `source/<host>/<path>` — 다운로드한 원본 바이트.
- `processed/<host>/<path>` — 서빙되는 오브젝트(PNG 입력은 WebP, 그 외에는 원본과 동일).
- `index/<sha256(url)>.json` — `{ url, key, contentType, updatedAt }`을 담는 index.
  요청 URL에서 key를 결정할 수 있어 서버 시작 시 전체 목록을 읽지 않습니다. 첫 요청에서
  해당 index 하나만 읽고 이후에는 메모리에 유지합니다. 암호화 backend에서는 이 논리
  key도 다시 경로 세그먼트별 EME 암호화 key로 변환됩니다.

`ObjectStorage` 인터페이스(`src/storage/types.ts`)에는 두 가지 구현이 있습니다.

- **`FsStorage`** — 베이스 디렉터리 하위 파일(`src/storage/fs-storage.ts`).
- **`S3Storage`** — AWS SDK v3를 통한 AWS S3 / MinIO / Cloudflare R2 / Backblaze B2 등
  (`src/storage/s3-storage.ts`).

백엔드는 런타임에 환경 변수로 선택되며, 앱의 나머지 부분은 `ObjectStorage`
인터페이스만 봅니다.

### 리다이렉트 서빙 (S3 대역폭 오프로드)

`S3_PUBLIC_URL_BASE` 또는 `S3_PRESIGN`을 설정하면, 캐시 적중 시 앱 서버가 바이트를
직접 스트리밍하는 대신 브라우저를 **S3/CDN URL로 302 리다이렉트**합니다. 이미지
전송 트래픽이 앱 서버를 거치지 않아 대역폭을 오프로드할 수 있습니다.

- `S3_PUBLIC_URL_BASE` — 공개 읽기 버킷/CDN의 public 오브젝트 URL로 리다이렉트.
- `S3_PRESIGN=true` — 비공개 버킷용. 만료 시간이 있는 presigned GET URL로 리다이렉트.
- 둘 다 미설정이면 `fs`와 동일하게 앱 서버가 바이트를 스트리밍합니다(기본값).

리다이렉트는 안전하게 **스트리밍으로 degrade**합니다: presigned URL 생성이 실패하면
(자격증명 문제 등) 503으로 떨어뜨리지 않고 앱 서버가 바이트를 직접 스트리밍합니다.
서빙 대상 오브젝트가 백엔드에서 사라진 경우에만 origin에서 재fetch하며 `503`을
반환합니다.

`/cached`의 응답 status·body 계약은 유지됩니다(처리 중 `503`, 그 외 origin 에러).
다만 프론트엔드는 `fetch(...).blob()`으로 이미지를 읽으므로, 리다이렉트 대상이
**다른 origin**이면 해당 버킷/CDN에 **CORS 설정**(앱 origin에 대한 `GET` 허용)이
필요합니다. 같은 origin(예: 리버스 프록시/CDN을 앱과 동일 도메인에 둠)으로 서빙하면
CORS 없이 동작합니다.

## 환경 변수

| 변수                       | 기본값      | 설명 |
| ------------------------- | ----------- | ---- |
| `PORT`                    | `3013`      | HTTP 포트 |
| `ORIGIN_MIN_INTERVAL_MS`  | `200`       | 다운로드 경로별로 동일 origin 호스트에 보내는 요청 간 최소 간격 |
| `ORIGIN_MAX_CONCURRENCY`  | `8`         | 다운로드 경로별 동일 origin 호스트 동시 다운로드 수 기본값(경로마다 설정 페이지에서 변경). `0`이면 사실상 무제한 |
| `ORIGIN_RETRIES`          | `2`         | 연결 단계 오류(ETIMEDOUT, ECONNRESET 등) 재시도 횟수. 1s, 2s backoff. HTTP 에러 status는 재시도하지 않음 |
| `ORIGIN_CONNECT_ATTEMPT_TIMEOUT_MS` | `2000` | 호스트가 여러 주소로 resolve될 때 주소 하나당 연결 시도 시간(Node 기본 250ms) |
| `PROXY_CONFIG`            | `proxy.json` | 프록시 목록 파일 |
| `PROXY_SETTINGS`          | `proxy-settings.json` | 경로별 enabled/concurrency 저장 파일 |
| `PROXY_IP_CHECK_URL`      | `https://ifconfig.me/ip` | 외부 IP를 평문으로 돌려주는 health check URL |
| `PROXY_CHECK_TIMEOUT_MS`  | `15000`     | 경로 하나의 health check 제한시간 |
| `PROXY_CHECK_INTERVAL_MS` | `600000`    | 전체 경로 재검사 주기. `0`이면 시작 시 한 번만 |
| `ERROR_RETRY_MS`          | `300000`    | 캐시된 origin 에러를 재시도 없이 그대로 반환하는 기간(ms). 이보다 오래된 에러는 다음 요청에서 origin 재시도. `0`이면 비활성화(에러 영구 캐시) |
| `CACHE_BACKEND`           | `fs`        | `fs` 또는 `s3` |
| `CACHE_DIR`               | `cache`     | `fs` 백엔드의 베이스 디렉터리 |
| `CACHE_ENCRYPTION`        | `false`     | `true`면 객체 본문과 논리 경로를 애플리케이션 계층에서 암호화 |
| `CACHE_ENCRYPTION_PASSPHRASE` | —       | 서버에서 마스터키를 해제할 passphrase (`CACHE_ENCRYPTION=true`에서 필수) |
| `S3_BUCKET`               | —           | 버킷 이름 (`s3`에서 필수) |
| `S3_REGION`               | `us-east-1` | 리전 |
| `S3_ENDPOINT`             | —           | S3 호환 서버의 커스텀 엔드포인트 (예: `http://localhost:9000`) |
| `S3_BROWSER_ENDPOINT`     | `S3_ENDPOINT` | 브라우저용 presigned URL에 넣을 endpoint. 쉼표로 여러 개 지정 가능하며 `이름=URL` 형식으로 이름을 붙일 수 있음(예: `cf=https://cdn.example.com,ts=https://s3.tailnet.ts.net`). 이름이 없으면 `browser`, `browser2`, … (`direct`는 `S3_ENDPOINT` 예약). 첫 항목이 기본값이고, `S3_ENDPOINT`와 합쳐 선택지가 2개 이상이면 메인 페이지의 *Image endpoint*에서 브라우저별로 고를 수 있음(선택은 localStorage에 저장, https 페이지에서는 http endpoint 비활성) |
| `S3_ACCESS_KEY_ID`        | —           | 미설정 시 기본 AWS 자격증명 체인 사용 |
| `S3_SECRET_ACCESS_KEY`    | —           | — |
| `S3_FORCE_PATH_STYLE`     | `true`      | path-style 주소 방식 (대부분의 비-AWS 서버에 필요) |
| `S3_PREFIX`               | —           | 여러 배포가 한 버킷을 공유할 수 있게 하는 key prefix |
| `S3_PUBLIC_URL_BASE`      | —           | 설정 시 캐시 이미지를 이 베이스 URL의 public 오브젝트로 **302 리다이렉트** 서빙 (예: `https://cdn.example.com`, path-style이면 버킷까지 포함 `http://minio:9000/img-cache`) |
| `S3_PRESIGN`              | `false`     | `true`면 public URL 대신 **presigned GET URL**로 302 리다이렉트 (비공개 버킷용) |
| `S3_PRESIGN_EXPIRES`      | `300`       | presigned URL 유효시간(초) |
| `S3_REQUEST_TIMEOUT_MS`   | `60000`     | S3 PUT 한 번의 제한시간(ms); 마이그레이션은 실패 시 3회 재시도 |

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

프로젝트 루트의 `.env`는 `dotenv`로 자동 로드되며, 이미 설정된 프로세스 환경 변수가
같은 이름의 `.env` 값보다 우선합니다.

## 비신뢰 저장소 암호화

`CACHE_ENCRYPTION=true`는 랜덤 256-bit 마스터키로 모든 이미지와 메타데이터를
AES-256-GCM 암호화합니다. 논리 key는 rclone crypt와 같은 방식으로 `/` 세그먼트마다
PKCS#7 패딩 후 EME(AES-256, 고정 tweak)로 암호화하고 소문자 base32hex로 인코딩해
`v2/` 아래에 저장하므로 S3에는 원본 호스트, 경로, 확장자가 나타나지 않습니다. 브라우저는 최초 이미지 표시 때
passphrase를 묻고, PBKDF2-SHA256(기본 600,000회)으로 S3에 저장된 마스터키 봉투를
해제합니다. 해제된 키는 현재 페이지의 메모리에만 유지됩니다.
AES content key와 경로 EME key·tweak은 HKDF-SHA256으로 마스터키에서 서로 독립적으로
파생됩니다.
브라우저의 Encryption key 패널에서 passphrase를 검증해 `localStorage`에 기억하거나
삭제하고 잠글 수 있습니다. 같은 origin에서 실행되는 JavaScript는 저장된 passphrase를
읽을 수 있으므로 개인용·신뢰 기기에서만 기억 기능을 사용해야 합니다.
S3 redirect가 설정된 경우 `/cached`는 암호문 URL과 원래 MIME type만 반환하며 실제
암호문 전송은 S3/CDN이 담당합니다. redirect가 없으면 서버가 암호문을 그대로 중계하고
복호화는 동일하게 브라우저에서 수행합니다.
`S3_PRESIGN=true`이면 `S3_PUBLIC_URL_BASE`는 사용되지 않으며, HTTPS
`S3_BROWSER_ENDPOINT`만으로 브라우저 직접 전송을 구성할 수 있습니다.

```bash
CACHE_BACKEND=s3 CACHE_ENCRYPTION=true \
CACHE_ENCRYPTION_PASSPHRASE='a long private passphrase' \
S3_BUCKET=img-cache npm start
```

passphrase 변경은 이미지 재암호화 없이 마스터키 봉투만 다시 암호화합니다. 실행 중인
서버를 정지하고 다음 명령을 수행한 뒤 새 passphrase로 재시작합니다.

```bash
CACHE_BACKEND=s3 S3_BUCKET=img-cache \
CACHE_ENCRYPTION_OLD_PASSPHRASE='old passphrase' \
CACHE_ENCRYPTION_NEW_PASSPHRASE='new long passphrase' \
npm run change-passphrase
```

키 봉투의 고정 bootstrap 객체명, 객체 개수·크기·접근 시각은 저장소에 노출됩니다. 경로
암호화는 결정적이므로 경로 depth, 같은 이름의 세그먼트(예: 같은 호스트 디렉터리 아래
객체들), 16-byte 단위로 반올림한 세그먼트 길이도 드러납니다. 실제 호스트·경로·파일명은
노출되지 않습니다. EME 이름에는 인증 태그가 없으므로 저장소 쓰기 권한자가 객체 이름을
서로 바꾸는 공격은 막지 않습니다(본문은 AES-GCM으로 인증됨). 브라우저 Web Crypto는
HTTPS(또는 localhost)에서만 사용할 수 있습니다.
최초 키 봉투 생성은 단일 서버 인스턴스로 수행해야 합니다. 잘못된 passphrase나 손상된
키 봉투가 감지되면 서버는 평문 fallback 없이 시작에 실패합니다.

경로를 복호화할 수 있으므로 별도 manifest 없이 `list()`가 동작합니다. 논리 prefix의 완전한
세그먼트는 암호화해 S3 `ListObjectsV2` prefix로 범위를 좁히고, 마지막 부분 세그먼트는 이름을
복호화한 뒤 비교합니다. 복호화되지 않는 이름은 목록에서 제외합니다. 세그먼트 하나는 최대
2047 byte이며, 암호화된 전체 key가 S3의 1024-byte 제한을 넘지 않아야 합니다.

## 백엔드 간 마이그레이션

`npm run migrate -- <from> <to>`는 모든 오브젝트(이미지 + index)를 한 백엔드에서
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
| `--encrypt-destination` | 목적지에 AES-GCM 암호문과 EME 암호화 경로로 기록 |

마이그레이션은 멱등적입니다 — 재실행하면 `--overwrite`가 없는 한 대상에 이미 존재하는
오브젝트를 건너뜁니다.

## 프로젝트 구조

```
src/
  server.ts            Express 앱 + 라우트 (프론트엔드 계약)
  egress-pool.ts       다운로드 경로(direct + SOCKS 프록시), health check, 경로별 동시성
  cache-manager.ts     URL 기반 온디맨드 index + 메모리 hot cache
  download-manager.ts  origin fetch, 호스트별 throttle, PNG→WebP 변환
  migrate.ts           fs <-> s3 마이그레이션 CLI
  storage/
    types.ts           ObjectStorage 인터페이스 + 백엔드 설정 타입
    fs-storage.ts      파일시스템 백엔드
    s3-storage.ts      S3 호환 백엔드
    factory.ts         환경 변수 기반 백엔드 선택
    encrypted-storage.ts  본문 AES-GCM + 경로 EME 암호화 어댑터
    crypto-format.ts   암호문 형식, 마스터키 봉투, PathCipher
    eme.ts             EME wide-block cipher (rfjakob/eme 호환)
    index.ts           배럴 익스포트
public/                정적 프론트엔드 (index.html, script.js, proxies.html, proxies.js, style.css)
```
