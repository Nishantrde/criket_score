const sqlite3 = require("sqlite3");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function onGet(err, row) {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function onAll(err, rows) {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await Promise.all([
    run(
      `CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        active_team TEXT NOT NULL,
        winner TEXT NOT NULL,

        teamA_name TEXT NOT NULL,
        teamA_runs INTEGER NOT NULL,
        teamA_wickets INTEGER NOT NULL,
        teamA_overs REAL NOT NULL,

        teamB_name TEXT NOT NULL,
        teamB_runs INTEGER NOT NULL,
        teamB_wickets INTEGER NOT NULL,
        teamB_overs REAL NOT NULL,

        raw_json TEXT NOT NULL
      );`
    ),
    run(
      `CREATE TABLE IF NOT EXISTS team_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        teamA_name TEXT NOT NULL,
        teamB_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`
    ),
    run(
      `CREATE TABLE IF NOT EXISTS admin_emails (
        email TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );`
    )
  ]);

  // Ensure default admin exists
  const defaultAdmin = (process.env.DEFAULT_ADMIN_EMAIL || "nishant.garg.dev@gmail.com").trim().toLowerCase();
  if (defaultAdmin) {
    await run(
      `INSERT OR IGNORE INTO admin_emails (email, created_at) VALUES (?, ?);`,
      [defaultAdmin, new Date().toISOString()]
    );
  }
}

async function getTeamNames() {
  const row = await get("SELECT teamA_name, teamB_name FROM team_settings WHERE id = 1;");
  if (!row) {
    return { teamAName: "Team A", teamBName: "Team B" };
  }
  return {
    teamAName: String(row.teamA_name || "Team A"),
    teamBName: String(row.teamB_name || "Team B")
  };
}

async function setTeamNames({ teamAName, teamBName }) {
  const updatedAt = new Date().toISOString();
  await run(
    `INSERT INTO team_settings (id, teamA_name, teamB_name, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       teamA_name = excluded.teamA_name,
       teamB_name = excluded.teamB_name,
       updated_at = excluded.updated_at;`,
    [teamAName, teamBName, updatedAt]
  );
  return { teamAName, teamBName, updatedAt };
}

async function listMatches({ limit = 5000 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 5000;
  return all(
    `SELECT
      id,
      created_at,
      active_team,
      winner,
      teamA_name, teamA_runs, teamA_wickets, teamA_overs,
      teamB_name, teamB_runs, teamB_wickets, teamB_overs
    FROM matches
    ORDER BY created_at DESC
    LIMIT ?;`,
    [safeLimit]
  );
}

async function insertMatch({ match, winner }) {
  const createdAt = new Date().toISOString();
  const rawJson = JSON.stringify({ match, winner, createdAt });

  const result = await run(
    `INSERT INTO matches (
      created_at, active_team, winner,
      teamA_name, teamA_runs, teamA_wickets, teamA_overs,
      teamB_name, teamB_runs, teamB_wickets, teamB_overs,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      createdAt,
      match.activeTeam,
      winner,
      match.teamA.name,
      match.teamA.runs,
      match.teamA.wickets,
      match.teamA.over,
      match.teamB.name,
      match.teamB.runs,
      match.teamB.wickets,
      match.teamB.over,
      rawJson
    ]
  );

  return { id: result.lastID, createdAt };
}

async function clearMatches() {
  const result = await run("DELETE FROM matches;");
  return { cleared: result.changes };
}

async function listAdminEmails() {
  const rows = await all("SELECT email, created_at FROM admin_emails ORDER BY email ASC;");
  return rows.map((r) => ({ email: String(r.email), createdAt: r.created_at }));
}

async function isAdminEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return false;
  const row = await get("SELECT email FROM admin_emails WHERE email = ?;", [norm]);
  return !!row;
}

async function addAdminEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) throw new Error("Email required");
  await run("INSERT OR IGNORE INTO admin_emails (email, created_at) VALUES (?, ?);", [
    norm,
    new Date().toISOString()
  ]);
  return { email: norm };
}

async function removeAdminEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) throw new Error("Email required");
  await run("DELETE FROM admin_emails WHERE email = ?;", [norm]);
  return { email: norm };
}

module.exports = {
  initDb,
  insertMatch,
  getTeamNames,
  setTeamNames,
  listMatches,
  clearMatches,
  listAdminEmails,
  isAdminEmail,
  addAdminEmail,
  removeAdminEmail
};
