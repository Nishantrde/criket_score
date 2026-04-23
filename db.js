const sqlite = require("./db_sqlite");

function wantMongo() {
  const kind = String(process.env.DB_KIND || "").trim().toLowerCase();
  if (kind === "sqlite") return false;
  if (kind === "mongo") return true;
  return !!process.env.MONGODB_URI;
}

function strictMongo() {
  return String(process.env.DB_KIND || "").trim().toLowerCase() === "mongo";
}

let backend = null;
let mongo = null;
let sqliteReady = false;
let choosingPromise = null;

async function ensureSqliteReady() {
  if (sqliteReady) return;
  await sqlite.initDb();
  sqliteReady = true;
}

async function chooseBackend() {
  if (backend) return backend;

  if (choosingPromise) {
    await choosingPromise;
    return backend;
  }

  choosingPromise = (async () => {
    if (wantMongo()) {
      try {
        mongo = mongo || require("./db_mongo");
        await mongo.initDb();
        backend = mongo;
        return;
      } catch (err) {
        console.error("MongoDB init failed; falling back to SQLite.", err);
        if (strictMongo()) throw err;
      }
    }

    await ensureSqliteReady();
    backend = sqlite;
  })();

  try {
    await choosingPromise;
  } finally {
    choosingPromise = null;
  }

  return backend;
}

async function withBackend(opName, fn) {
  const b = await chooseBackend();
  try {
    return await fn(b);
  } catch (err) {
    const isMongoActive = b === mongo;
    const msg = String(err?.message || "");
    const mongoLikelyDown =
      msg.includes("buffering timed out") ||
      msg.includes("server selection") ||
      msg.includes("ECONN") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("Mongo") ||
      msg.includes("Topology") ||
      msg.includes("timed out");

    if (isMongoActive && mongoLikelyDown && !strictMongo()) {
      console.error(`MongoDB ${opName} failed; switching to SQLite.`, err);
      backend = null;
      mongo = null;
      await ensureSqliteReady();
      backend = sqlite;
      return await fn(backend);
    }
    throw err;
  }
}

async function initDb() {
  await chooseBackend();
}

async function getTeamNames() {
  return withBackend("getTeamNames", (b) => b.getTeamNames());
}

async function setTeamNames({ teamAName, teamBName }) {
  return withBackend("setTeamNames", (b) => b.setTeamNames({ teamAName, teamBName }));
}

async function listMatches({ limit } = {}) {
  return withBackend("listMatches", (b) => b.listMatches({ limit }));
}

async function insertMatch({ match, winner }) {
  return withBackend("insertMatch", (b) => b.insertMatch({ match, winner }));
}

async function clearMatches() {
  return withBackend("clearMatches", (b) => b.clearMatches());
}

async function deleteMatch(id) {
  return withBackend("deleteMatch", (b) => b.deleteMatch(id));
}

module.exports = {
  initDb,
  getTeamNames,
  setTeamNames,
  listMatches,
  insertMatch,
  clearMatches,
  deleteMatch
};
