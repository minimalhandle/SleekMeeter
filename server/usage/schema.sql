-- One row per install ID per UTC day.
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  edition TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
CREATE INDEX IF NOT EXISTS pings_id ON pings (id);
