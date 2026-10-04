// 지원하는 격리 시험 DB 종류와 명령별 연결 환경의 경계를 정의한다.
import { z } from 'zod';

export const databaseResourceKinds = ['postgres-test', 'mysql-test', 'mariadb-test', 'mssql-test', 'oracle-test', 'mongodb-test'] as const;
export const databaseResourceKindSchema = z.enum(databaseResourceKinds);
export type DatabaseResourceKind = z.infer<typeof databaseResourceKindSchema>;
const binaryHash = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativePostgresProviderSchema = z.strictObject({
  mode: z.literal('native'),
  binaryRoot: z.string().min(1).max(4096).refine(value =>
    /^(?:[A-Za-z]:[\\/]|\/)/u.test(value) && !/[\x00-\x1f\x7f]/u.test(value), '절대 실행 파일 폴더가 필요합니다.'),
  postgresVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u),
  sha256: z.strictObject({ initdb: binaryHash, pg_ctl: binaryHash, postgres: binaryHash }),
});
export const resourceProviderSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('docker') }), nativePostgresProviderSchema,
]);
export type ResourceProvider = z.infer<typeof resourceProviderSchema>;
export type NativePostgresProvider = z.infer<typeof nativePostgresProviderSchema>;

// 자원이 필요한 선택 명령 전체는 하나의 동결 제공자만 사용한다.
export function selectedResourceProvider(commands: readonly { resources?: DatabaseResourceKind[] | undefined; resourceProvider?: ResourceProvider | undefined }[]): ResourceProvider | undefined {
  const selected = commands.filter(command => command.resources?.length);
  const first = selected[0]?.resourceProvider;
  for (const command of selected) {
    const provider = command.resourceProvider;
    if ((provider?.mode ?? 'docker') !== (first?.mode ?? 'docker')
      || (provider?.mode === 'native' && (command.resources!.some(kind => kind !== 'postgres-test')
        || first?.mode !== 'native' || provider.binaryRoot !== first.binaryRoot
        || provider.postgresVersion !== first.postgresVersion
        || (['initdb', 'pg_ctl', 'postgres'] as const).some(name => provider.sha256[name] !== first.sha256[name]))))
      throw new Error('선택 명령의 시험 자원 제공자가 일치하지 않습니다.');
  }
  return first;
}
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
