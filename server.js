const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const path = require("path");
const {
  initDb,
  insertMatch,
  getTeamNames,
  setTeamNames,
  listMatches,
  clearMatches,
  deleteMatch
} = require("./db");

const PORT = Number.parseInt(process.env.PORT, 10) || 3131;

const io = new Server(server, {
  // If WebSockets are blocked in production, Socket.IO will fall back to polling (often feels slower).
  // These settings keep defaults but make connectivity issues easier to spot and help detect dead clients sooner.
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.json());

const ADMIN_USER = String(process.env.ADMIN_USER || "air19818");
const ADMIN_PASS = String(process.env.ADMIN_PASS || "air19818");

const ADMIN_SOCKET_TOKEN_TTL_MS = 1000 * 60 * 10; // 10 minutes
const adminSocketTokens = new Map(); // token -> expiresAtMs
let liveViewerCount = 0;

function parseBasicAuth(headerValue) {
  const h = String(headerValue || "");
  if (!h.toLowerCase().startsWith("basic ")) return null;
  const b64 = h.slice(6).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function isValidAdminCreds(user, pass) {
  return String(user) === ADMIN_USER && String(pass) === ADMIN_PASS;
}

function ensureAdminBasic(req, res, next) {
  const creds = parseBasicAuth(req.headers.authorization);
  if (creds && isValidAdminCreds(creds.user, creds.pass)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Admin authentication required." });
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Cricket Admin"');
  return res.status(401).send("Authentication required");
}

function issueAdminSocketToken() {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + ADMIN_SOCKET_TOKEN_TTL_MS;
  adminSocketTokens.set(token, expiresAt);
  return { token, expiresAt };
}

function isValidAdminSocketToken(token) {
  const t = String(token || "");
  if (!t) return false;
  const expiresAt = adminSocketTokens.get(t);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    adminSocketTokens.delete(t);
    return false;
  }
  return true;
}

app.get("/admin", ensureAdminBasic, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/client", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

// prevent direct HTML access bypassing the above route guards
app.get("/index.html", ensureAdminBasic, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/client.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

app.get("/", (req, res) => {
  return res.redirect("/client");
});

// serve frontend
app.use(express.static("public"));

let match = {
  activeTeam: "teamA",
  winner: null,
  teamA: { name: "Team A", runs: 0, wickets: 0, over: 0.0, players: [], bowlers: [], currentBowlerId: "" },
  teamB: { name: "Team B", runs: 0, wickets: 0, over: 0.0, players: [], bowlers: [], currentBowlerId: "" }
};

function overToBalls(value) {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  const safe = Number.isFinite(num) && num >= 0 ? num : 0;
  const overs = Math.floor(safe);
  const balls = Math.round((safe - overs) * 10);
  return overs * 6 + Math.max(0, balls);
}

function ballsToOverNumber(totalBalls) {
  const safe = Number.isFinite(totalBalls) && totalBalls >= 0 ? Math.floor(totalBalls) : 0;
  const overs = Math.floor(safe / 6);
  const balls = safe % 6;
  return overs + balls / 10;
}

function normalizeOver(value) {
  return ballsToOverNumber(overToBalls(value));
}

const VALID_PLAYER_STATUSES = new Set(["striker", "non-striker", "waiting", "out"]);

function normalizePlayer(player, index = 0) {
  const rawName = String(player?.name ?? "").trim();
  const statusValue = String(player?.status || "").toLowerCase();
  const status = VALID_PLAYER_STATUSES.has(statusValue) ? statusValue : "waiting";
  const runs = Number(player?.runs ?? 0);
  const overs = normalizeOver(player?.overs ?? 0);

  return {
    id: String(player?.id ?? `player-${index + 1}`),
    name: rawName,
    runs: Number.isFinite(runs) && runs >= 0 ? Math.floor(runs) : 0,
    status,
    overs
  };
}

function normalizePlayers(players) {
  const list = Array.isArray(players) ? players.map((player, index) => normalizePlayer(player, index)) : [];
  let strikerSeen = false;
  let nonStrikerSeen = false;

  return list.map((player) => {
    if (player.status === "striker") {
      if (strikerSeen) return { ...player, status: "waiting" };
      strikerSeen = true;
      return player;
    }

    if (player.status === "non-striker") {
      if (nonStrikerSeen) return { ...player, status: "waiting" };
      nonStrikerSeen = true;
      return player;
    }

    return player;
  });
}

function normalizeBowler(bowler, index = 0) {
  const rawName = String(bowler?.name ?? "").trim();
  const runsConceded = Number(bowler?.runsConceded ?? 0);
  const wickets = Number(bowler?.wickets ?? 0);
  const overs = normalizeOver(bowler?.overs ?? 0);

  return {
    id: String(bowler?.id ?? `bowler-${index + 1}`),
    name: rawName,
    runsConceded: Number.isFinite(runsConceded) && runsConceded >= 0 ? Math.floor(runsConceded) : 0,
    wickets: Number.isFinite(wickets) && wickets >= 0 ? Math.floor(wickets) : 0,
    overs
  };
}

function normalizeBowlers(bowlers) {
  return Array.isArray(bowlers) ? bowlers.map((bowler, index) => normalizeBowler(bowler, index)) : [];
}

function normalizeTeam(team, fallbackName) {
  const name = String(team?.name ?? fallbackName);
  const runs = Number(team?.runs ?? 0);
  const wickets = Number(team?.wickets ?? 0);
  const over = normalizeOver(team?.over);
  const bowlers = normalizeBowlers(team?.bowlers);
  const currentBowlerId = String(team?.currentBowlerId ?? "").trim();
  const normalizedCurrentBowlerId = currentBowlerId && bowlers.some((bowler) => bowler.id === currentBowlerId)
    ? currentBowlerId
    : String(bowlers[0]?.id ?? "");

  return {
    name: name || fallbackName,
    runs: Number.isFinite(runs) && runs >= 0 ? Math.floor(runs) : 0,
    wickets: Number.isFinite(wickets) && wickets >= 0 ? Math.floor(wickets) : 0,
    over,
    players: normalizePlayers(team?.players),
    bowlers,
    currentBowlerId: normalizedCurrentBowlerId
  };
}

function normalizeMatchState(state) {
  const activeTeam = state?.activeTeam === "teamB" ? "teamB" : "teamA";
  return {
    activeTeam,
    winner: validateWinner(state?.winner) ? state.winner : null,
    teamA: normalizeTeam(state?.teamA, "Team A"),
    teamB: normalizeTeam(state?.teamB, "Team B")
  };
}

function validateWinner(winner) {
  return winner === "teamA" || winner === "teamB";
}

function cleanTeamName(value, fallback) {
  const name = String(value ?? "").trim();
  if (!name) return fallback;
  return name.slice(0, 60);
}

function namesChanged(nextMatch) {
  return (
    nextMatch?.teamA?.name !== match?.teamA?.name ||
    nextMatch?.teamB?.name !== match?.teamB?.name
  );
}

async function emitMatchesUpdate(target) {
  try {
    const matches = await listMatches({ limit: 5000 });
    if (target) target.emit("matchesUpdate", matches);
    else io.emit("matchesUpdate", matches);
  } catch (err) {
    console.error("Failed to emit matchesUpdate", err);
  }
}

function emitViewerCount(target = io) {
  target.emit("viewerCount", liveViewerCount);
}

app.get("/api/matches", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query?.limit, 10);
    const matches = await listMatches({ limit: Number.isFinite(limit) ? limit : 5000 });
    return res.json({ ok: true, matches });
  } catch (err) {
    console.error("List matches failed", err);
    return res.status(500).json({ ok: false, error: "Failed to load match history." });
  }
});

app.get("/api/admin/socket-token", ensureAdminBasic, (req, res) => {
  const issued = issueAdminSocketToken();
  return res.json({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
});

app.put("/api/teams", ensureAdminBasic, async (req, res) => {
  try {
    const teamAName = cleanTeamName(req.body?.teamAName, match.teamA.name);
    const teamBName = cleanTeamName(req.body?.teamBName, match.teamB.name);

    if (!teamAName || !teamBName) {
      return res.status(400).json({ ok: false, error: "Both team names are required." });
    }

    await setTeamNames({ teamAName, teamBName });
    match = normalizeMatchState({
      ...match,
      teamA: { ...match.teamA, name: teamAName },
      teamB: { ...match.teamB, name: teamBName }
    });
    io.emit("matchUpdate", match);
    io.emit("scoreUpdate", match[match.activeTeam]);
    return res.json({ ok: true, teamAName, teamBName });
  } catch (err) {
    console.error("Update team names failed", err);
    return res.status(500).json({ ok: false, error: "Failed to update team names." });
  }
});

app.post("/api/matches", async (req, res) => {
  try {
    // protect recording a match
    const creds = parseBasicAuth(req.headers.authorization);
    if (!creds || !isValidAdminCreds(creds.user, creds.pass)) {
      return res.status(401).json({ ok: false, error: "Admin authentication required." });
    }

    const winner = req.body?.winner;
    if (!validateWinner(winner)) {
      return res.status(400).json({ ok: false, error: "Winner is required (teamA/teamB)." });
    }

    const incomingMatch = normalizeMatchState(req.body?.match ?? req.body);

    // Basic completeness validation
    if (!incomingMatch.teamA.name || !incomingMatch.teamB.name) {
      return res.status(400).json({ ok: false, error: "Team names are required." });
    }

    if (!Number.isFinite(incomingMatch.teamA.runs) || !Number.isFinite(incomingMatch.teamB.runs)) {
      return res.status(400).json({ ok: false, error: "Match data is incomplete." });
    }

    if (
      !Number.isFinite(incomingMatch.teamA.wickets) ||
      !Number.isFinite(incomingMatch.teamB.wickets) ||
      !Number.isFinite(incomingMatch.teamA.over) ||
      !Number.isFinite(incomingMatch.teamB.over)
    ) {
      return res.status(400).json({ ok: false, error: "Match data is incomplete." });
    }

    if (
      incomingMatch.teamA.runs < 0 ||
      incomingMatch.teamB.runs < 0 ||
      incomingMatch.teamA.wickets < 0 ||
      incomingMatch.teamB.wickets < 0 ||
      incomingMatch.teamA.over < 0 ||
      incomingMatch.teamB.over < 0
    ) {
      return res.status(400).json({ ok: false, error: "Match data is invalid." });
    }

    const saved = await insertMatch({ match: incomingMatch, winner });
    emitMatchesUpdate();
    return res.json({ ok: true, id: saved.id, createdAt: saved.createdAt });
  } catch (err) {
    console.error("Record match failed", err);
    return res.status(500).json({ ok: false, error: "Failed to record match." });
  }
});

app.delete("/api/matches", ensureAdminBasic, async (req, res) => {
  try {
    await clearMatches();
    emitMatchesUpdate();
    return res.json({ ok: true });
  } catch (err) {
    console.error("Clear matches failed", err);
    return res.status(500).json({ ok: false, error: "Failed to clear match history." });
  }
});

app.delete("/api/matches/:id", ensureAdminBasic, async (req, res) => {
  try {
    const removed = await deleteMatch(req.params.id);
    if (!removed.deleted) {
      return res.status(404).json({ ok: false, error: "Match not found." });
    }

    emitMatchesUpdate();
    return res.json({ ok: true, deleted: removed.deleted });
  } catch (err) {
    console.error("Delete match failed", err);
    return res.status(500).json({ ok: false, error: "Failed to delete match." });
  }
});

function isAdminSocket(socket) {
  const token = socket.handshake?.auth?.adminToken;
  if (isValidAdminSocketToken(token)) return true;

  const creds = parseBasicAuth(socket.handshake?.headers?.authorization);
  if (creds && isValidAdminCreds(creds.user, creds.pass)) return true;
  return false;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  console.log("Transport:", socket.conn.transport?.name);
  liveViewerCount += 1;

  socket.conn.on("upgrade", (transport) => {
    console.log("Transport upgraded:", transport?.name);
  });

  // send current match on join
  socket.emit("matchUpdate", match);

  emitMatchesUpdate(socket);

  // backward compatibility
  socket.emit("scoreUpdate", match[match.activeTeam]);
  emitViewerCount();

  socket.on("joinMatch", () => {
    console.log("User joined match");
  });

  socket.on("updateMatch", async (data) => {
    try {
      if (!isAdminSocket(socket)) return;

      const nextMatch = normalizeMatchState(data);
      const shouldPersistNames = namesChanged(nextMatch);
      match = nextMatch;
      io.emit("matchUpdate", match);
      io.emit("scoreUpdate", match[match.activeTeam]);

      if (shouldPersistNames) {
        const teamAName = cleanTeamName(match.teamA.name, "Team A");
        const teamBName = cleanTeamName(match.teamB.name, "Team B");
        setTeamNames({ teamAName, teamBName }).catch((err) => {
          console.error("Failed to persist team names", err);
        });
      }
    } catch (err) {
      console.error("updateMatch failed", err);
    }
  });

  // backward compatibility: update active team only
  socket.on("updateScore", async (data) => {
    try {
      if (!isAdminSocket(socket)) return;

      match[match.activeTeam] = normalizeTeam(
        {
          ...match[match.activeTeam],
          runs: data?.runs,
          wickets: data?.wickets,
          over: data?.over
        },
        match.activeTeam === "teamA" ? "Team A" : "Team B"
      );
      io.emit("matchUpdate", match);
      io.emit("scoreUpdate", match[match.activeTeam]);
    } catch (err) {
      console.error("updateScore failed", err);
    }
  });

  socket.on("recordMatch", async (payload, ack) => {
    try {
      if (!isAdminSocket(socket)) {
        if (typeof ack === "function") ack({ ok: false, error: "Admin authentication required." });
        return;
      }

      const winner = payload?.winner;
      if (!validateWinner(winner)) {
        if (typeof ack === "function") ack({ ok: false, error: "Winner is required (teamA/teamB)." });
        return;
      }

      const incomingMatch = normalizeMatchState(payload?.match ?? payload);
      if (!incomingMatch.teamA.name || !incomingMatch.teamB.name) {
        if (typeof ack === "function") ack({ ok: false, error: "Team names are required." });
        return;
      }

      if (
        !Number.isFinite(incomingMatch.teamA.runs) ||
        !Number.isFinite(incomingMatch.teamB.runs) ||
        !Number.isFinite(incomingMatch.teamA.wickets) ||
        !Number.isFinite(incomingMatch.teamB.wickets) ||
        !Number.isFinite(incomingMatch.teamA.over) ||
        !Number.isFinite(incomingMatch.teamB.over)
      ) {
        if (typeof ack === "function") ack({ ok: false, error: "Match data is incomplete." });
        return;
      }

      if (
        incomingMatch.teamA.runs < 0 ||
        incomingMatch.teamB.runs < 0 ||
        incomingMatch.teamA.wickets < 0 ||
        incomingMatch.teamB.wickets < 0 ||
        incomingMatch.teamA.over < 0 ||
        incomingMatch.teamB.over < 0
      ) {
        if (typeof ack === "function") ack({ ok: false, error: "Match data is invalid." });
        return;
      }

      const saved = await insertMatch({ match: incomingMatch, winner });
      emitMatchesUpdate();
      if (typeof ack === "function") ack({ ok: true, id: saved.id, createdAt: saved.createdAt });
    } catch (err) {
      console.error("Socket recordMatch failed", err);
      if (typeof ack === "function") ack({ ok: false, error: "Failed to record match." });
    }
  });

  socket.on("deleteMatch", async (payload, ack) => {
    try {
      if (!isAdminSocket(socket)) {
        if (typeof ack === "function") ack({ ok: false, error: "Admin authentication required." });
        return;
      }

      const matchId = String(payload?.id ?? payload ?? "").trim();
      if (!matchId) {
        if (typeof ack === "function") ack({ ok: false, error: "Match id is required." });
        return;
      }

      const removed = await deleteMatch(matchId);
      if (!removed.deleted) {
        if (typeof ack === "function") ack({ ok: false, error: "Match not found." });
        return;
      }

      emitMatchesUpdate();
      if (typeof ack === "function") ack({ ok: true, deleted: removed.deleted });
    } catch (err) {
      console.error("Socket deleteMatch failed", err);
      if (typeof ack === "function") ack({ ok: false, error: "Failed to delete match." });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    liveViewerCount = Math.max(0, liveViewerCount - 1);
    emitViewerCount();
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Another server instance is already running.`);
    process.exit(0);
  }
  console.error("Server failed to start", err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

(async () => {
  try {
    await initDb();
    const names = await getTeamNames();
    match = normalizeMatchState({
      ...match,
      teamA: { ...match.teamA, name: names.teamAName },
      teamB: { ...match.teamB, name: names.teamBName }
    });
  } catch (err) {
    console.error("Failed to init database", err);
  }
})();
