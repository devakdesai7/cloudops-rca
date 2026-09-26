CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  affected_endpoint TEXT,
  status TEXT NOT NULL,
  hypothesis_json JSONB,
  proposed_fix_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  time_to_resolution_ms INTEGER
);

CREATE TABLE incident_services (
  id SERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  service TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  evidence_json JSONB,
  UNIQUE (incident_id, service)
);

CREATE TABLE approvals (
  id SERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
