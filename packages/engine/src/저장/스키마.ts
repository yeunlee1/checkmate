// 체크메이트 SQLite 저장 스키마 버전과 초기 적용 내용을 정의한다.
import { createHash } from 'node:crypto';

export const schemaVersion = 1;

const hex = '[0-9a-f]';
const digit = '[0-9]';
const uuidPattern = `${hex.repeat(8)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(4)}-${hex.repeat(12)}`;
const utcPrefix = `${digit.repeat(4)}-${digit.repeat(2)}-${digit.repeat(2)}T${digit.repeat(2)}:${digit.repeat(2)}:${digit.repeat(2)}`;
const uuid = (column: string) => `${column} GLOB '${uuidPattern}'`;
const hash = (column: string) => `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const json = (column: string) => `json_valid(${column})`;
const utc = (column: string) => `length(${column}) >= 20 AND substr(${column}, -1) = 'Z'
  AND substr(${column}, 1, 19) GLOB '${utcPrefix}'
  AND (length(${column}) = 20 OR (length(${column}) > 21 AND substr(${column}, 20, 1) = '.'
    AND substr(${column}, 21, length(${column}) - 21) NOT GLOB '*[^0-9]*'))
  AND coalesce(strftime('%Y-%m-%dT%H:%M:%S', ${column}) = substr(${column}, 1, 19), 0)
  AND coalesce(date(${column}, '+0 days') = substr(${column}, 1, 10), 0)`;

export const schemaSql = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (typeof(version) = 'integer' AND version > 0),
  checksum TEXT NOT NULL CHECK (${hash('checksum')}),
  applied_at TEXT NOT NULL CHECK (${utc('applied_at')}),
  app_version TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE projects (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  name TEXT NOT NULL CHECK (length(name) > 0),
  repository_identity TEXT NOT NULL CHECK (length(repository_identity) > 0),
  active_catalog_id TEXT CHECK (active_catalog_id IS NULL OR ${uuid('active_catalog_id')}),
  created_at TEXT NOT NULL CHECK (${utc('created_at')}),
  archived_at TEXT CHECK (archived_at IS NULL OR ${utc('archived_at')}),
  FOREIGN KEY (id, active_catalog_id) REFERENCES catalogs(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE workspaces (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  real_path TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(real_path) > 0),
  path_fingerprint TEXT NOT NULL CHECK (${hash('path_fingerprint')}),
  created_at TEXT NOT NULL CHECK (${utc('created_at')})
);

CREATE TABLE catalogs (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (${hash('content_hash')}),
  source_json TEXT NOT NULL CHECK (${json('source_json')}),
  created_at TEXT NOT NULL CHECK (${utc('created_at')}),
  UNIQUE (project_id, id),
  UNIQUE (project_id, content_hash)
);

CREATE TRIGGER workspaces_project_fixed BEFORE UPDATE OF project_id ON workspaces
BEGIN
  SELECT RAISE(ABORT, 'workspace-project-fixed');
END;

CREATE TRIGGER catalogs_project_fixed BEFORE UPDATE OF project_id ON catalogs
BEGIN
  SELECT RAISE(ABORT, 'catalog-project-fixed');
END;

CREATE TABLE definitions (
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('requirement', 'check', 'baseline', 'profile')),
  definition_id TEXT NOT NULL CHECK (length(definition_id) > 0),
  content_json TEXT NOT NULL CHECK (${json('content_json')}),
  PRIMARY KEY (catalog_id, kind, definition_id)
);

CREATE TABLE requirement_checks (
  catalog_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (typeof(required) = 'integer' AND required IN (0, 1)),
  requirement_kind TEXT NOT NULL DEFAULT 'requirement' CHECK (requirement_kind = 'requirement'),
  check_kind TEXT NOT NULL DEFAULT 'check' CHECK (check_kind = 'check'),
  PRIMARY KEY (catalog_id, requirement_id, check_id),
  FOREIGN KEY (catalog_id, requirement_kind, requirement_id)
    REFERENCES definitions(catalog_id, kind, definition_id) ON DELETE RESTRICT,
  FOREIGN KEY (catalog_id, check_kind, check_id)
    REFERENCES definitions(catalog_id, kind, definition_id) ON DELETE RESTRICT
);

CREATE TABLE plans (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (${hash('fingerprint')}),
  plan_json TEXT NOT NULL CHECK (${json('plan_json')}),
  source_hash TEXT NOT NULL CHECK (${hash('source_hash')}),
  created_at TEXT NOT NULL CHECK (${utc('created_at')})
);

CREATE TRIGGER plans_same_project_insert BEFORE INSERT ON plans
BEGIN
  SELECT RAISE(ABORT, 'plan-project-mismatch')
  WHERE (SELECT project_id FROM workspaces WHERE id = NEW.workspace_id)
     IS NOT (SELECT project_id FROM catalogs WHERE id = NEW.catalog_id);
END;

CREATE TRIGGER plans_same_project_update BEFORE UPDATE OF workspace_id, catalog_id ON plans
BEGIN
  SELECT RAISE(ABORT, 'plan-project-mismatch')
  WHERE (SELECT project_id FROM workspaces WHERE id = NEW.workspace_id)
     IS NOT (SELECT project_id FROM catalogs WHERE id = NEW.catalog_id);
END;

CREATE TABLE approvals (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
  scope_hash TEXT NOT NULL CHECK (${hash('scope_hash')}),
  scope_json TEXT NOT NULL CHECK (${json('scope_json')}),
  evidence_kind TEXT NOT NULL CHECK (length(evidence_kind) > 0),
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) > 0),
  granted_at TEXT NOT NULL CHECK (${utc('granted_at')}),
  expires_at TEXT CHECK (expires_at IS NULL OR ${utc('expires_at')}),
  revoked_at TEXT CHECK (revoked_at IS NULL OR ${utc('revoked_at')})
);

CREATE TABLE runs (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('live', 'imported')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'blocked', 'cancelled', 'unverifiable')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('passed', 'failed', 'incomplete', 'unknown')),
  phase TEXT NOT NULL CHECK (length(phase) > 0),
  worker_exit_code INTEGER CHECK (worker_exit_code IS NULL OR typeof(worker_exit_code) = 'integer'),
  started_at TEXT NOT NULL CHECK (${utc('started_at')}),
  finished_at TEXT CHECK (finished_at IS NULL OR ${utc('finished_at')}),
  finalized_at TEXT CHECK (finalized_at IS NULL OR ${utc('finalized_at')}),
  summary_json TEXT NOT NULL CHECK (${json('summary_json')}),
  CHECK (origin != 'imported' OR verdict IS NULL OR verdict = 'unknown')
);

CREATE TABLE requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (${hash('request_hash')}),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, request_id)
);

CREATE TABLE steps (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal > 0),
  status TEXT NOT NULL CHECK (length(status) > 0),
  exit_code INTEGER CHECK (exit_code IS NULL OR typeof(exit_code) = 'integer'),
  observed_json TEXT NOT NULL CHECK (${json('observed_json')}),
  PRIMARY KEY (run_id, step_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE case_results (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  test_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt > 0),
  requirement_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not-run', 'skipped', 'timed-out', 'interrupted', 'unknown')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  expected_json TEXT CHECK (expected_json IS NULL OR ${json('expected_json')}),
  observed_json TEXT CHECK (observed_json IS NULL OR ${json('observed_json')}),
  location_json TEXT CHECK (location_json IS NULL OR ${json('location_json')}),
  PRIMARY KEY (run_id, test_id, attempt)
);

CREATE TABLE evidence (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
  sha256 TEXT NOT NULL CHECK (${hash('sha256')}),
  byte_length INTEGER NOT NULL CHECK (typeof(byte_length) = 'integer' AND byte_length >= 0),
  mime TEXT NOT NULL CHECK (length(mime) > 0),
  sensitivity TEXT NOT NULL CHECK (length(sensitivity) > 0),
  state TEXT NOT NULL CHECK (state IN ('staged', 'ready', 'missing', 'quarantined')),
  UNIQUE (run_id, relative_path)
);

CREATE TABLE gaps (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT,
  opened_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  resolved_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  state TEXT NOT NULL CHECK (length(state) > 0),
  detail_json TEXT NOT NULL CHECK (${json('detail_json')})
);

CREATE TABLE resources (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  owner_token_hash TEXT NOT NULL CHECK (${hash('owner_token_hash')}),
  state TEXT NOT NULL CHECK (length(state) > 0),
  descriptor_json TEXT NOT NULL CHECK (${json('descriptor_json')}),
  cleanup_json TEXT CHECK (cleanup_json IS NULL OR ${json('cleanup_json')})
);

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence > 0),
  type TEXT NOT NULL CHECK (type IN ('step-started', 'case-result', 'evidence-created', 'resource-intent', 'resource-created', 'resource-cleaned', 'step-finished', 'worker-finished')),
  recorded_at TEXT NOT NULL CHECK (${utc('recorded_at')}),
  payload_json TEXT NOT NULL CHECK (${json('payload_json')}),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE audit_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (${uuid('id')}),
  action TEXT NOT NULL CHECK (length(action) > 0),
  actor_kind TEXT NOT NULL CHECK (length(actor_kind) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  before_hash TEXT CHECK (before_hash IS NULL OR ${hash('before_hash')}),
  after_hash TEXT CHECK (after_hash IS NULL OR ${hash('after_hash')}),
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL CHECK (${utc('recorded_at')}),
  detail_json TEXT NOT NULL CHECK (${json('detail_json')})
);

CREATE INDEX runs_workspace_started ON runs(workspace_id, started_at DESC, id);
CREATE INDEX runs_state ON runs(state);
CREATE INDEX case_results_run_status ON case_results(run_id, status);
CREATE INDEX evidence_run_state ON evidence(run_id, state);
CREATE INDEX gaps_project_state ON gaps(project_id, state);
CREATE INDEX audit_events_entity_recorded ON audit_events(entity_id, recorded_at);
`;

export const schemaChecksum = createHash('sha256').update(schemaSql, 'utf8').digest('hex');

export const schemaTables = [
  'schema_migrations', 'projects', 'workspaces', 'catalogs', 'definitions',
  'requirement_checks', 'plans', 'approvals', 'runs', 'requests', 'steps',
  'case_results', 'evidence', 'gaps', 'resources', 'events', 'audit_events',
] as const;
