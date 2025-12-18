PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS days (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL, -- JST YYYY-MM-DD
  status TEXT NOT NULL CHECK(status IN ('workout','skip')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  skip_points INTEGER NOT NULL,
  consec_workout INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
