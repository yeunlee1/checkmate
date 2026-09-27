# 다중 DB 검사.

체크메이트는 등록된 Node 시험 명령을 새 합성 DB에 연결한다. 기존 서버 주소나 운영 자료를 등록해 자동 검사하는 기능은 아니다. 실제 업무 검증은 대상 프로젝트의 시험 코드와 마이그레이션이 담당한다. 이번 변경은 아틀리에 자체의 DB 종류를 바꾸거나 기존 검사 목록을 갱신하지 않는다.

## 지원 범위.

| 종류 | 명령의 resources 값 | 연결 환경 접두어 | 고정 이미지 계열 |
|---|---|---|---|
| PostgreSQL | `postgres-test` | `CHECKMATE_PG_` | PostgreSQL 17 alpine |
| MySQL | `mysql-test` | `CHECKMATE_MYSQL_` | MySQL 8.4 |
| MariaDB | `mariadb-test` | `CHECKMATE_MARIADB_` | MariaDB 11.4 |
| SQL Server | `mssql-test` | `CHECKMATE_MSSQL_` | SQL Server 2022 Developer |
| Oracle | `oracle-test` | `CHECKMATE_ORACLE_` | Oracle Database Free lite |
| MongoDB | `mongodb-test` | `CHECKMATE_MONGO_` | MongoDB 8.0 단일 서버 |

이미지는 `packages/engine/src/자원/데이터베이스종류.ts`에 SHA256 digest까지 고정한다. 태그가 갱신되어도 자동으로 다른 이미지를 실행하지 않는다. 현재 실제 수용 대상은 Windows의 로컬 Linux Docker, x86_64다. SQL Server Developer는 개발·시험 전용이다. SQL Server와 Oracle의 사용 조건은 실행 승인 계획에 표시된다. 상용 운영판·구버전·원격 DB·클러스터·MongoDB 복제 집합과 다중 문서 트랜잭션을 지원한다고 해석하지 않는다.

로컬 Docker와 충분한 메모리·이미지 저장 공간이 필요하다. 특히 Oracle은 초기 준비 시간이 다른 DB보다 길다. 하나의 실행에 여러 DB를 선언할 수 있지만 해당 종류들이 함께 실행되므로 컴퓨터 용량에 맞춰 프로필을 나눈다. 첫 실행은 고정 이미지 다운로드 시간이 추가될 수 있다.

## 연결 방법.

기존 `checkmate/프로젝트.json`의 검사 명령에 필요한 종류를 선언한다. 아래는 SQL Server용 명령 예다. 해당 명령을 참조하는 검사항목·요구사항·프로필도 같은 프로젝트에 등록한다.

```json
{
  "id": "verify-mssql",
  "title": "SQL Server 저장 검사",
  "runtime": "node",
  "entry": "tests/체크메이트DB.mjs",
  "args": [],
  "timeoutMs": 900000,
  "env": { "NODE_ENV": "test" },
  "writes": [],
  "resultFormat": "exit-code",
  "resources": ["mssql-test"]
}
```

각 접두어에 `MANAGED=1`과 `CONNECTION_JSON`을 전달한다. JSON에는 `host`, `port`, `user`, `password`, `database`가 있다. SQL Server에는 시험용 암호화·인증서 옵션인 `options.encrypt=true`, `options.trustServerCertificate=true`가 있으며 Oracle에는 `connectString`, MongoDB에는 `authSource=admin`이 있다. PostgreSQL은 기존 `CHECKMATE_PG_ADMIN_URL`도 제공한다.

연결 정보는 프로세스 환경으로만 전달한다. 프로젝트 JSON에 복사하거나 출력·로그·증거로 저장하지 않는다. 검사 명령은 `MANAGED`와 연결 JSON을 필수로 확인하고 누락되면 실패해야 한다. `.env`나 기존 로컬 DB를 대신 사용하지 않는다. 선언하지 않은 종류의 연결 환경 및 사용자가 위조한 예약 접두어는 전달하지 않는다.

SQL Server에서 프로젝트가 이미 사용하는 `mssql` 드라이버를 연결하는 예다. DB 드라이버는 대상 프로젝트가 설치하며 체크메이트가 대상 프로젝트의 의존성을 변경하지 않는다. 합성 데이터베이스를 만드는 것부터 시험 코드에서 처리한다. 예시의 `exit-code`는 명령 단위 판정이며 개별 검사항목의 증거에는 `ndjson` 리포터를 사용한다.

```js
// 체크메이트가 전달한 SQL Server에만 연결해 합성 자료를 확인한다.
import sql from 'mssql';
if (process.env.CHECKMATE_MSSQL_MANAGED !== '1') throw new Error('시험 연결 없음');
const config = JSON.parse(process.env.CHECKMATE_MSSQL_CONNECTION_JSON ?? 'null');
if (!config || config.host !== '127.0.0.1') throw new Error('시험 연결 오류');
const { host, ...options } = config;
const pool = new sql.ConnectionPool({ ...options, server: host });
try {
  await pool.connect();
  const result = await pool.request().query('SELECT 1 AS value');
  if (result.recordset[0]?.value !== 1) throw new Error('조회 결과 오류');
} finally {
  await pool.close();
}
```

MySQL·MariaDB는 해당 JSON을 대상 드라이버의 접속 설정으로 사용한다. Oracle은 `user`, `password`, `connectString`을 사용하고, MongoDB는 전달한 호스트·포트와 `authSource`, 계정으로 인증한다. 다른 DB용 SQL이나 ORM 설정을 그대로 재사용하지 말고 각 DB에 맞는 시험을 등록한다.

## 소유권과 실패 처리.

부모 서비스가 생성 전 실행 ID·자원 ID·소유 토큰 해시·이미지·로컬 Docker daemon을 기록한다. 연결은 loopback의 동적 포트이며 자료는 컨테이너 tmpfs에만 생성한다. 기존 볼륨, 호스트 디렉터리, 원격 Docker 연결은 허용하지 않는다. MongoDB의 두 데이터 경로도 모두 tmpfs를 사용한다.

준비 단계는 DB별 클라이언트의 실제 인증과 고정 조회, 호스트 포트 연결을 확인한다. 연결 확인은 대상 앱 전체 업무 검증을 대신하지 않는다. 암호는 Docker 명령 인자에 넣지 않으며 Oracle SQL*Plus 입력은 stdin으로 전달한다. 같은 OS 사용자나 Docker 관리자에 대한 보안 격리 기능은 아니다.

한 종류의 준비가 실패해도 이미 만든 본인 자원은 정리 대상으로 남는다. 생성 응답·프로세스 종료·소유권·컨테이너 부재가 불명확하면 미확인으로 보존한다. 다른 종류나 소유 라벨, 이미지, 마운트, 포트가 발견되면 임의 종료하지 않는다. 기존 사람 전용 정리 확인과 과거 실행 판정은 변경하지 않는다.

## 검증 방법.

`npm test`는 합성 Docker 응답, SQLite 저장, 실제 자식 프로세스에 대한 연결 환경 분리 등 회귀 시험이다. 실제 Docker의 수용 검사는 별도로 `node scripts/다중DB검증.mjs`를 실행한다. 특정 종류만 확인하려면 `node scripts/다중DB검증.mjs mssql-test`처럼 지정한다. 실행 전에 해당 컴퓨터에서 새 합성 DB 생성·쓰기·삭제 범위가 승인되어 있어야 한다.

실제 수용 스크립트는 새 UUID 기록 아래에서만 자원을 만들고, 인증·쓰기·조회·중복 기본키 거절·관계형 롤백·합성 자료 삭제·소유 컨테이너 부재를 확인한다. MongoDB는 단일 서버의 CRUD와 중복 거절을 확인하며 트랜잭션 시험으로 표시하지 않는다. 실패한 결과는 덮어쓰지 않는다. 기록은 `.runtime/검증/다중DB/<UUID>/결과.json`에 남는다.

`node scripts/다중DB연결검증.mjs`는 다른 새 합성 자료 폴더에서 공개 CLI의 기능 조회·등록·계획·승인·실행을 거쳐 여섯 종류와 MySQL/SQL Server 동시 선언을 확인한다. 이 검사의 자식 명령은 연결 JSON 분리와 호스트 포트를 확인하며, DB 준비 인증은 부모가 수행한다. 결과의 최종 판정·소스 동일·증거·정리까지 대조하고, 업무 CRUD 자체의 근거는 앞선 실제 DB 수용과 구분한다.

## 확인한 수용 결과.

2026-09-28 Windows와 로컬 Linux Docker에서 고정 이미지 여섯 종류를 직접 확인했다. `npm test`는 43파일의 357개 통과·기존 2개 건너뜀이고, 실제 Electron 검사는 여섯 종류의 영어 승인 안내와 미승인 실행 차단, 네 화면 크기·확대 조건의 넘침 없음과 접근성 위반 0을 확인했다.

- DB 직접 수용은 `.runtime/검증/다중DB/2dc8d052-ed0a-4775-b805-7045100df775/결과.json`, SHA256 `ABCD1644A033847C9B8B6D8E10CC7C81EA4FD884FA7E17441C02E957919D4814`다. 여섯 종류의 인증·쓰기·조회·중복 거절·삭제와 소유 컨테이너 정리를 확인했다. 관계형 다섯 종류는 롤백을 확인했고 MongoDB 단일 서버의 다중 문서 트랜잭션은 제외했다.
- 공개 CLI 수용은 `.runtime/검증/다중DB연결/b57e2d76-8e24-4fb2-8c88-adac357e2cee/결과.json`, SHA256 `5EB010F80B6BF4E91698F910B71678A3C89C464BF19E3F01BFC7B5EDA5027C0B`다. 여섯 단독 종류와 MySQL/SQL Server 조합의 일곱 실행 모두 최종 통과·소스 전후 동일·증거 무결성·재사용 가능한 통과·정리 확인을 통과했다.
- 첫 DB 수용 `5c1ec0bf-3d21-49f1-97a6-1cf551252381`의 PostgreSQL·SQL Server·Oracle 실패는 보존했다. 인증과 정리는 확인했지만 시험 스크립트가 초기 DDL과 롤백을 한 호출로 묶거나 SQL*Plus 문장을 줄로 분리하지 않았다. 시험 단계를 분리한 뒤 위 새 실행으로 재검증했다.

이 결과는 체크메이트의 로컬 격리 DB 지원 근거다. 실제 고객 자료, 대상 앱 전체, 클러스터, 설치본 교체, 운영 배포 또는 아틀리에 기존 `65841e2e`의 사람 정리 확인 완료를 뜻하지 않는다.

## 공식 설정 근거.

- [MySQL 공식 컨테이너](https://hub.docker.com/_/mysql).
- [MariaDB 공식 환경 변수](https://mariadb.com/docs/server/server-management/automated-mariadb-deployment-and-administration/docker-and-mariadb/mariadb-server-docker-official-image-environment-variables).
- [SQL Server 컨테이너 환경 변수](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-configure-environment-variables?view=sql-server-ver17).
- [Node SQL Server 연결 예제](https://github.com/tediousjs/node-mssql).
- [Oracle 공식 컨테이너](https://github.com/oracle/docker-images/blob/main/OracleDatabase/SingleInstance/README.md).
- [MongoDB 공식 컨테이너](https://hub.docker.com/_/mongo).
