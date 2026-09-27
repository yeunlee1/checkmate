// 지원하는 격리 시험 DB 종류와 명령별 연결 환경의 경계를 정의한다.
import { z } from 'zod';

export const databaseResourceKinds = ['postgres-test', 'mysql-test', 'mariadb-test', 'mssql-test', 'oracle-test', 'mongodb-test'] as const;
export const databaseResourceKindSchema = z.enum(databaseResourceKinds);
export type DatabaseResourceKind = z.infer<typeof databaseResourceKindSchema>;
export const databaseResourceNames: Record<DatabaseResourceKind, string> = {
  'postgres-test': 'PostgreSQL', 'mysql-test': 'MySQL', 'mariadb-test': 'MariaDB',
  'mssql-test': 'SQL Server', 'oracle-test': 'Oracle', 'mongodb-test': 'MongoDB',
};
export const databaseEnvironmentPrefixes: Record<DatabaseResourceKind, string> = {
  'postgres-test': 'CHECKMATE_PG_', 'mysql-test': 'CHECKMATE_MYSQL_', 'mariadb-test': 'CHECKMATE_MARIADB_',
  'mssql-test': 'CHECKMATE_MSSQL_', 'oracle-test': 'CHECKMATE_ORACLE_', 'mongodb-test': 'CHECKMATE_MONGO_',
};

export function selectDatabaseEnvironment(kinds: readonly DatabaseResourceKind[], values: Record<string, string>): Record<string, string> {
  const prefixes = kinds.map(kind => databaseEnvironmentPrefixes[kind]);
  return Object.fromEntries(Object.entries(values).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))));
}
