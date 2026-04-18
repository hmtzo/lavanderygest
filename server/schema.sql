-- Lavandery schema (SQLite)
CREATE TABLE IF NOT EXISTS technicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pin TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS condominiums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  type TEXT NOT NULL,       -- Lavadora | Secadora
  brand TEXT,
  capacity TEXT,
  installed_at INTEGER
);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  technician_id TEXT REFERENCES technicians(id),
  condo_id TEXT REFERENCES condominiums(id),
  visit_type TEXT,
  status TEXT NOT NULL,             -- draft | finalized
  score INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  checkin_geo TEXT,                 -- json {lat,lng,acc}
  general TEXT,                     -- json
  conclusion TEXT,                  -- json
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS visit_infrastructure (
  visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
  energy TEXT, internet TEXT, lighting TEXT, exhaust TEXT,
  drainage TEXT, cleaning TEXT, notes TEXT
);

CREATE TABLE IF NOT EXISTS visit_machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id TEXT REFERENCES visits(id) ON DELETE CASCADE,
  machine_id TEXT REFERENCES machines(id),
  code TEXT, type TEXT,
  status TEXT,                      -- ok | warn | fail
  problem TEXT,                     -- Mau uso | Falha técnica | ...
  notes TEXT
);

CREATE TABLE IF NOT EXISTS visit_supplies (
  visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
  soap TEXT, softener TEXT, doser TEXT,
  replenish_needed INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS visit_photos (
  id TEXT PRIMARY KEY,
  visit_id TEXT REFERENCES visits(id) ON DELETE CASCADE,
  tag TEXT,                         -- lavanderia | máquina | erro | infraestrutura
  taken_at INTEGER,
  path TEXT                         -- server-side stored file path
);

CREATE INDEX IF NOT EXISTS idx_visits_condo ON visits(condo_id);
CREATE INDEX IF NOT EXISTS idx_visits_tech ON visits(technician_id);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_vm_visit ON visit_machines(visit_id);
