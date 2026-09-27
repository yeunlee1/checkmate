// DB별 고정 이미지와 합성 계정 및 인증된 준비 확인 명령을 정의한다.
import { databaseEnvironmentPrefixes, type DatabaseResourceKind } from '@checkmate/contracts/resources';

export type DatabaseCommand = { args: string[]; env?: Record<string, string>; input?: string };
export type DatabaseSpec = {
  image: string; prefix: string; port: number; user: string; database: string;
  tmpfs: Record<string, string>; extraPorts: string[]; readyAttempts: number;
  environment: (password: string) => Record<string, string>;
  probe: (password: string) => DatabaseCommand;
};
const flags = 'rw,nosuid,nodev';
export const databaseSpecs: Record<DatabaseResourceKind, DatabaseSpec> = {
  'postgres-test': {
    image: 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
    prefix: 'pg', port: 5432, user: 'respiro_test', database: 'respiro_test',
    tmpfs: { '/var/lib/postgresql/data': flags }, extraPorts: [], readyAttempts: 30,
    environment: password => ({ POSTGRES_DB: 'respiro_test', POSTGRES_USER: 'respiro_test', POSTGRES_PASSWORD: password }),
    probe: password => ({ args: ['psql', '-h', '127.0.0.1', '-U', 'respiro_test', '-d', 'respiro_test', '-tAc', 'SELECT 1'], env: { PGPASSWORD: password } }),
  },
  'mysql-test': {
    image: 'mysql:8.4@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d',
    prefix: 'mysql', port: 3306, user: 'root', database: 'checkmate_test',
    tmpfs: { '/var/lib/mysql': flags }, extraPorts: ['33060/tcp'], readyAttempts: 180,
    environment: password => ({ MYSQL_ROOT_PASSWORD: password, MYSQL_ROOT_HOST: '%', MYSQL_DATABASE: 'checkmate_test', MYSQL_INITDB_SKIP_TZINFO: '1' }),
    probe: password => ({ args: ['mysql', '--protocol=TCP', '-h127.0.0.1', '-uroot', '-NBe', 'SELECT 1'], env: { MYSQL_PWD: password } }),
  },
  'mariadb-test': {
    image: 'mariadb:11.4@sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b',
    prefix: 'mariadb', port: 3306, user: 'root', database: 'checkmate_test',
    tmpfs: { '/var/lib/mysql': flags }, extraPorts: [], readyAttempts: 180,
    environment: password => ({ MARIADB_ROOT_PASSWORD: password, MARIADB_ROOT_HOST: '%', MARIADB_DATABASE: 'checkmate_test', MARIADB_INITDB_SKIP_TZINFO: '1' }),
    probe: password => ({ args: ['mariadb', '--protocol=TCP', '-h127.0.0.1', '-uroot', '-NBe', 'SELECT 1'], env: { MYSQL_PWD: password } }),
  },
  'mssql-test': {
    image: 'mcr.microsoft.com/mssql/server:2022-latest@sha256:4402d880dd4c34bfa7d8705e56a86cd6c88da80a1f6bbbe741f999e76264a090',
    prefix: 'mssql', port: 1433, user: 'sa', database: 'master',
    tmpfs: { '/var/opt/mssql': `${flags},uid=10001,gid=0,mode=0770` }, extraPorts: [], readyAttempts: 240,
    environment: password => ({ ACCEPT_EULA: 'Y', MSSQL_PID: 'Developer', MSSQL_SA_PASSWORD: password }),
    probe: password => ({ args: ['/opt/mssql-tools18/bin/sqlcmd', '-S', 'tcp:127.0.0.1,1433', '-U', 'sa', '-C', '-b', '-l', '3', '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; SELECT 1;'], env: { SQLCMDPASSWORD: password } }),
  },
  'oracle-test': {
    image: 'container-registry.oracle.com/database/free:latest-lite@sha256:cf540c3fa190d7cffad08c491652ac07fc70314e510f6b87890449517d565e94',
    prefix: 'oracle', port: 1521, user: 'SYSTEM', database: 'FREEPDB1',
    tmpfs: { '/opt/oracle/oradata': `${flags},uid=54321,gid=54321,mode=0770` }, extraPorts: ['5500/tcp'], readyAttempts: 480,
    environment: password => ({ ORACLE_PWD: password }),
    probe: password => ({ args: ['sqlplus', '-L', '-S', '/nolog'], input: `WHENEVER SQLERROR EXIT FAILURE\nWHENEVER OSERROR EXIT FAILURE\nCONNECT SYSTEM/"${password}"@//127.0.0.1:1521/FREEPDB1\nSET HEADING OFF FEEDBACK OFF PAGESIZE 0\nSELECT 1 FROM DUAL;\nEXIT\n` }),
  },
  'mongodb-test': {
    image: 'mongo:8.0@sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2',
    prefix: 'mongo', port: 27017, user: 'checkmate_test', database: 'checkmate_test',
    tmpfs: { '/data/db': flags, '/data/configdb': flags }, extraPorts: [], readyAttempts: 180,
    environment: password => ({ MONGO_INITDB_ROOT_USERNAME: 'checkmate_test', MONGO_INITDB_ROOT_PASSWORD: password }),
    probe: password => ({ args: ['mongosh', '--quiet', '--host', '127.0.0.1', '--eval', 'const admin = db.getSiblingDB("admin"); if (!admin.auth("checkmate_test", process.env.CHECKMATE_DB_PASSWORD).ok) quit(1); print(admin.runCommand({ ping: 1 }).ok);'], env: { CHECKMATE_DB_PASSWORD: password } }),
  },
};

export function databaseConnection(kind: DatabaseResourceKind, port: number, password: string): { environment: Record<string, string>; secrets: string[] } {
  const spec = databaseSpecs[kind];
  const prefix = databaseEnvironmentPrefixes[kind];
  const connection = JSON.stringify({ host: '127.0.0.1', port, user: spec.user, password, database: spec.database,
    ...(kind === 'mssql-test' ? { options: { encrypt: true, trustServerCertificate: true } } : {}),
    ...(kind === 'oracle-test' ? { connectString: `127.0.0.1:${port}/FREEPDB1` } : {}),
    ...(kind === 'mongodb-test' ? { authSource: 'admin' } : {}) });
  const environment: Record<string, string> = { [`${prefix}MANAGED`]: '1', [`${prefix}CONNECTION_JSON`]: connection };
  const secrets = [password, connection];
  if (kind === 'postgres-test') {
    const url = `postgresql://${spec.user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${spec.database}`;
    environment.CHECKMATE_PG_ADMIN_URL = url;
    secrets.push(url);
  }
  return { environment, secrets };
}
