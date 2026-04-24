const mongoose = require("mongoose");

const DEFAULT_ADMIN_EMAIL = "nishant.garg.dev@gmail.com";

let isConnected = false;
let connectingPromise = null;

const SettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    teamAName: { type: String, required: true, default: "Team A" },
    teamBName: { type: String, required: true, default: "Team B" },
    adminEmails: { type: [String], required: true, default: [DEFAULT_ADMIN_EMAIL] },
    updatedAt: { type: Date, required: true, default: () => new Date() }
  },
  { collection: "settings" }
);

const PlayerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    runs: { type: Number, required: true, default: 0 },
    overs: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ["striker", "non-striker", "waiting", "out"], required: true, default: "waiting" }
  },
  { _id: false }
);

const BowlerSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    wickets: { type: Number, required: true, default: 0 },
    overs: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const MatchSchema = new mongoose.Schema(
  {
    createdAt: { type: Date, required: true, default: () => new Date() },
    activeTeam: { type: String, enum: ["teamA", "teamB"], required: true },
    winner: { type: String, enum: ["teamA", "teamB"], required: true },
    teamA: {
      name: { type: String, required: true },
      runs: { type: Number, required: true },
      wickets: { type: Number, required: true },
      overs: { type: Number, required: true },
      players: { type: [PlayerSchema], default: [] },
      bowlers: { type: [BowlerSchema], default: [] }
    },
    teamB: {
      name: { type: String, required: true },
      runs: { type: Number, required: true },
      wickets: { type: Number, required: true },
      overs: { type: Number, required: true },
      players: { type: [PlayerSchema], default: [] },
      bowlers: { type: [BowlerSchema], default: [] }
    }
  },
  { collection: "matches" }
);

const Settings = mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
const Match = mongoose.models.Match || mongoose.model("Match", MatchSchema);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function connectMongo() {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  if (connectingPromise) {
    await connectingPromise;
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  // Fail fast if Mongo is unreachable (important for production)
  mongoose.set("bufferCommands", false);

  connectingPromise = (async () => {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 7000,
      connectTimeoutMS: 7000,
      socketTimeoutMS: 15000
    });
    // Ensure the underlying connection is fully established.
    if (typeof mongoose.connection.asPromise === "function") {
      await mongoose.connection.asPromise();
    }
    isConnected = true;
  })();

  try {
    await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function initDb() {
  await connectMongo();
  const defaultAdmin = normalizeEmail(process.env.DEFAULT_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);
  const existing = await Settings.findById("global").lean();
  if (!existing) {
    await Settings.create({
      _id: "global",
      teamAName: "Team A",
      teamBName: "Team B",
      adminEmails: defaultAdmin ? [defaultAdmin] : [],
      updatedAt: new Date()
    });
  } else if (defaultAdmin && !existing.adminEmails?.includes(defaultAdmin)) {
    await Settings.updateOne(
      { _id: "global" },
      { $addToSet: { adminEmails: defaultAdmin }, $set: { updatedAt: new Date() } }
    );
  }
}

async function getTeamNames() {
  await connectMongo();
  const s = await Settings.findById("global").lean();
  return {
    teamAName: String(s?.teamAName || "Team A"),
    teamBName: String(s?.teamBName || "Team B")
  };
}

async function setTeamNames({ teamAName, teamBName }) {
  await connectMongo();
  await Settings.updateOne(
    { _id: "global" },
    { $set: { teamAName, teamBName, updatedAt: new Date() } },
    { upsert: true }
  );
  return { teamAName, teamBName, updatedAt: new Date().toISOString() };
}

async function listMatches({ limit = 5000 } = {}) {
  await connectMongo();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 5000;
  const rows = await Match.find({}).sort({ createdAt: -1 }).limit(safeLimit).lean();
  return rows.map((m) => ({
    id: String(m._id),
    created_at: new Date(m.createdAt).toISOString(),
    active_team: m.activeTeam,
    winner: m.winner,
    teamA_name: m.teamA.name,
    teamA_runs: m.teamA.runs,
    teamA_wickets: m.teamA.wickets,
    teamA_overs: m.teamA.overs,
    teamA_players: Array.isArray(m.teamA.players) ? m.teamA.players : [],
    teamA_bowlers: Array.isArray(m.teamA.bowlers) ? m.teamA.bowlers : [],
    teamB_name: m.teamB.name,
    teamB_runs: m.teamB.runs,
    teamB_wickets: m.teamB.wickets,
    teamB_overs: m.teamB.overs,
    teamB_players: Array.isArray(m.teamB.players) ? m.teamB.players : [],
    teamB_bowlers: Array.isArray(m.teamB.bowlers) ? m.teamB.bowlers : []
  }));
}

async function insertMatch({ match, winner }) {
  await connectMongo();
  const createdAt = new Date();
  const doc = await Match.create({
    createdAt,
    activeTeam: match.activeTeam,
    winner,
    teamA: {
      name: match.teamA.name,
      runs: match.teamA.runs,
      wickets: match.teamA.wickets,
      overs: match.teamA.over,
      players: Array.isArray(match.teamA.players) ? match.teamA.players : [],
      bowlers: Array.isArray(match.teamA.bowlers) ? match.teamA.bowlers : []
    },
    teamB: {
      name: match.teamB.name,
      runs: match.teamB.runs,
      wickets: match.teamB.wickets,
      overs: match.teamB.over,
      players: Array.isArray(match.teamB.players) ? match.teamB.players : [],
      bowlers: Array.isArray(match.teamB.bowlers) ? match.teamB.bowlers : []
    }
  });
  return { id: String(doc._id), createdAt: createdAt.toISOString() };
}

async function clearMatches() {
  await connectMongo();
  const res = await Match.deleteMany({});
  return { cleared: res.deletedCount || 0 };
}

async function deleteMatch(id) {
  await connectMongo();
  const matchId = String(id || "").trim();
  if (!matchId) throw new Error("Valid match id required");

  const res = await Match.deleteOne({ _id: matchId });
  return { deleted: res.deletedCount || 0 };
}

async function listAdminEmails() {
  await connectMongo();
  const s = await Settings.findById("global").lean();
  const emails = Array.isArray(s?.adminEmails) ? s.adminEmails : [];
  return emails
    .map((e) => ({ email: String(e), createdAt: null }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function isAdminEmail(email) {
  await connectMongo();
  const norm = normalizeEmail(email);
  if (!norm) return false;
  const s = await Settings.findById("global").lean();
  return Array.isArray(s?.adminEmails) && s.adminEmails.includes(norm);
}

async function addAdminEmail(email) {
  await connectMongo();
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email required");
  await Settings.updateOne(
    { _id: "global" },
    { $addToSet: { adminEmails: norm }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  return { email: norm };
}

async function removeAdminEmail(email) {
  await connectMongo();
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email required");
  await Settings.updateOne(
    { _id: "global" },
    { $pull: { adminEmails: norm }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  return { email: norm };
}

module.exports = {
  initDb,
  insertMatch,
  getTeamNames,
  setTeamNames,
  listMatches,
  clearMatches,
  deleteMatch,
  listAdminEmails,
  isAdminEmail,
  addAdminEmail,
  removeAdminEmail
};
