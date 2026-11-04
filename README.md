# Pacer — 팀 과제·마감 코치 에이전트

팀 리더가 맡긴 과제를 작은 단계와 중간 마감으로 나눠 담당자에게 전달하고, 매일 체크인으로 진행을 확인하며 응원과 피드백을 주고, 막힌 일과 마감 위험만 팀 리더에게 요약해 알려 주는 Discord 봇.

기획안: https://gist.github.com/tnsgud/f42aedc07cec4f9c0183602534c5818d

## 기술 스택

| 영역 | 선택 |
| --- | --- |
| 런타임 | Node 24 LTS + TypeScript (실행 `tsx`, 빌드 `tsc`) |
| Discord | `discord.js` v14, Gateway 상시 접속 (슬래시 명령·버튼·모달·DM) |
| 스케줄 | `node-cron`, `timezone: 'Asia/Seoul'` |
| DB | SQLite (`better-sqlite3`) + `drizzle-orm/better-sqlite3` (마이그레이션 `drizzle-kit`) |
| AI | Groq (OpenAI 호환 `fetch`) 기본, Cloudflare Workers AI REST 대비용 |
| 검증 | `zod` (AI가 만든 단계 초안 JSON 검증) |
| 테스트 | `vitest` (영업일·마감 위험 계산만) |
| 배포 | 회사 서버, Docker (`node:24-slim`) + Docker Compose |

## 결정 사항과 이유

- **Cloudflare Workers 대신 회사 서버의 Node 봇.** Workers는 Gateway 상시 접속이 안 돼 "@코치 한 줄 등록"과 DM 자유 입력을 쓸 수 없고, 슬래시 명령은 3초 안에 응답해야 하며, Cron이 UTC로 고정된다. 서버에서 돌리면 이 제약이 모두 사라진다.
- **Supabase 대신 SQLite.** 사용자 2명, 컨테이너 1개 규모라 별도 DB 서비스가 주는 이점이 없다. 계정과 키 관리만 늘어난다.
- **Drizzle ORM.** 스키마를 TypeScript로 정의하고 타입을 추론해 쓴다. 테이블이 3~4개라 가볍다.
- **AI 기본값은 Groq.** 서버에는 Workers AI 바인딩이 없다. 한국어 품질은 같은 과제를 두 쪽에 넣어 비교해 정하고, 호출부를 함수 하나로 감싸 교체를 쉽게 한다.
- **Node 24 LTS 런타임.** `discord.js`의 공식 지원 런타임이라 Gateway 안정성 위험이 없다. Bun은 검토했으나 쓰지 않는다. `.nvmrc`와 `engines`를 24로 맞춘다.
- **드라이버는 `better-sqlite3`.** 동기식이라 코드가 단순하다. Node 내장 `node:sqlite`는 아직 실험 단계라 쓰지 않는다.
- **Flue 미적용.** Flue는 도구를 쓰며 스스로 판단하는 자율 에이전트용 하네스(Astro 팀, 실험 단계)다. 이 봇은 순서가 고정된 워크플로에 AI 호출이 세 곳(단계 초안, 힌트·응원, 요약)뿐이라 직접 짠 `ai.ts` 함수로 충분하다. 나중에 에이전트가 코드·문서를 읽고 스스로 조사해야 하면 다시 검토한다.

## 핵심 루프

과제 등록 → 단계 초안 → 팀 리더 확인 → 매일 체크인 → 기록·응원 또는 막힘 지원 → 팀 리더 요약

## 폴더 구조 (계획)

```
src/
  index.ts      봇 시작, Cron 등록, 마이그레이션 실행
  commands.ts   /과제 슬래시 명령, 버튼·모달 처리
  jobs.ts       아침 안내, 저녁 체크인, 팀 리더 요약
  ai.ts         단계 초안, 힌트, 요약
  db.ts         DB 연결과 쿼리 함수 모음
  schema.ts     Drizzle 스키마 (tasks, steps, checkins, members)
  dates.ts      영업일·마감 위험 계산 (테스트 대상)
drizzle/        생성된 마이그레이션 SQL
data/           SQLite 파일 (볼륨 마운트)
Dockerfile
docker-compose.yml
.env.example
```

## 운영 주의사항

- **DB 볼륨 마운트 필수.** `docker-compose.yml`에서 `./data:/app/data`로 연결한다. 컨테이너 안에 두면 이미지를 다시 빌드할 때 데이터가 사라진다.
- **백업은 직접 챙긴다.** 서버 cron으로 하루 한 번 `sqlite3 data/pacer.db ".backup 'backup/pacer-날짜.db'"`를 실행한다. 파일 복사는 쓰는 도중 깨질 수 있으니 `.backup` 명령을 쓴다. 회사 서버의 백업 정책에 `data/`가 포함되는지 확인한다.
- **마이그레이션 폴더를 이미지에 복사한다.** `drizzle/`가 없으면 시작할 때 `migrate()`가 실패한다.
- **베이스 이미지는 `node:24-slim`.** `better-sqlite3`는 네이티브 모듈이라 alpine(musl)에서 빌드 문제가 생기기 쉽고, slim(glibc)이 안전하다. 개발 PC와 서버 CPU 구조가 다르면 이미지는 서버에서 빌드한다.
- **DB 연결 직후 `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`을 실행한다.**
- **재시작 대응.** 시작할 때 오늘 체크인이 이미 나갔는지 DB로 확인하고, 놓쳤으면 한 번만 보낸다.
- **Discord 개발자 포털에서 Message Content Intent를 켠다.** "@코치 한 줄 등록"에 필요하다.
- **방화벽.** 아웃바운드로 Discord, Groq에 나갈 수 있어야 한다. Gateway 방식은 인바운드 포트가 필요 없다.
- **데이터 보관.** 체크인 원문은 저장하지 않고 상태와 요약만 남긴다. 팀 리더에게도 원문은 보내지 않는다.

## 개발 순서

1. 봇 접속, `/과제` 명령, AI 단계 초안, 팀 리더 승인 버튼
2. 저녁 Cron으로 DM 체크인과 버튼 처리
3. 아침 요약과 마감 위험 계산
4. Dockerfile과 Compose로 서버 배포

## MVP 범위 밖

- 팀원 전체 적용 (실습생 2명으로 2주 운영 후 확대)
- 팀 리더 여러 명. 지금은 `LEADER_ID` 한 명. 늘릴 때 할 일: `LEADER_ID`를 쉼표 구분 `LEADER_IDS`로 바꾸고, `tasks`에 `leader_id` 컬럼을 추가해 맡긴 사람을 기록하고(기존 행은 현재 리더 ID로 채움), 아침 요약·막힘 보고를 그 리더에게만 보낸다.
- 웹 대시보드, GitHub·이슈 트래커 연동
- 인사 평가·성과 점수화, 코드 리뷰 자동화
- DM 자유 입력 답장 (서버라 가능하지만 MVP는 버튼과 입력창으로 시작)

## 환경 변수 (`.env`)

`DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `LEADER_ID`(팀 리더 Discord ID), `GROQ_API_KEY`, `GROQ_MODEL`(기본 `qwen/qwen3.8-27b`), `DATABASE_PATH`(기본 `data/pacer.db`)

## 실행

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev            # 개발
npm test               # 영업일·마감 위험 계산 테스트
npm run db:generate    # schema.ts 변경 후 마이그레이션 생성
docker compose up -d --build   # 서버 배포
```

## 성공 기준 (실습생 2명, 2주)

- 단계 초안의 80% 이상이 팀 리더 수정 1회 이내로 확정
- 체크인 응답률 80% 이상 (영업일 10일 중 8일)
- 막힘이 생긴 뒤 팀 리더가 알기까지 1영업일 이내
- 마감을 놓친 과제 0건, 위험하면 최소 2일 전 경고
