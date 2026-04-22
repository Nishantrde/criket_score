const sqlite = require("./db_sqlite");

function shouldUseMongo() {
  if (process.env.DB_KIND) return String(process.env.DB_KIND).toLowerCase() === "mongo";
  return !!process.env.MONGODB_URI;
}

let mongo = null;

function getBackend() {
  if (shouldUseMongo()) {
    if (!mongo) mongo = require("./db_mongo");
    return mongo;
  }
  return sqlite;
}

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      const backend = getBackend();
      return backend[prop];
    }
  }
);
