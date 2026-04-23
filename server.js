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
  clearMatches
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

const MAX_WICKETS = 10;

function createDefaultBatter(name) {
  return {
    name,
    runs: 0,
    balls: 0
  };
}

function createDefaultBowler(name) {
  return {
    name,
    balls: 0,
    runs: 0,
    wickets: 0
  };
}

let match = {
  activeTeam: "teamA",
  winner: null,
  teamA: {
    name: "Team A",
    runs: 0,
    wickets: 0,
    over: 0,
    legalBalls: 0,
    extras: { wide: 0, noBall: 0, bye: 0, total: 0 },
    batting: {
      striker: createDefaultBatter("Team A Batter 1"),
      nonStriker: createDefaultBatter("Team A Batter 2"),
      nextBatsmanNumber: 3
    },
    bowling: {
      currentBowler: "Bowler 1",
      bowlers: {
        "Bowler 1": createDefaultBowler("Bowler 1")
      }
    }
  },
  teamB: {
    name: "Team B",
    runs: 0,
    wickets: 0,
    over: 0,
    legalBalls: 0,
    extras: { wide: 0, noBall: 0, bye: 0, total: 0 },
    batting: {
      striker: createDefaultBatter("Team B Batter 1"),
      nonStriker: createDefaultBatter("Team B Batter 2"),
      nextBatsmanNumber: 3
    },
    bowling: {
      currentBowler: "Bowler 1",
      bowlers: {
        "Bowler 1": createDefaultBowler("Bowler 1")
      }
    }
  }
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

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clampInt(value, min, max) {
  const n = toSafeInt(value, min);
  return Math.min(max, Math.max(min, n));
}

function cleanName(value, fallback, maxLen = 60) {
  const name = String(value ?? "").trim();
  if (!name) return fallback;
  return name.slice(0, maxLen);
}

function normalizeBatter(player, fallbackName) {
  const name = cleanName(player?.name, fallbackName, 48);
  return {
    name,
    runs: Math.max(0, toSafeInt(player?.runs, 0)),
    balls: Math.max(0, toSafeInt(player?.balls, 0))
  };
}

function normalizeBowler(bowler, fallbackName) {
  const name = cleanName(bowler?.name, fallbackName, 48);
  return {
    name,
    balls: Math.max(0, toSafeInt(bowler?.balls, 0)),
    runs: Math.max(0, toSafeInt(bowler?.runs, 0)),
    wickets: Math.max(0, toSafeInt(bowler?.wickets, 0))
  };
}

function normalizeBowling(bowling) {
  const source = typeof bowling === "object" && bowling !== null ? bowling : {};
  const incomingBowlers =
    typeof source.bowlers === "object" && source.bowlers !== null ? source.bowlers : {};
  const bowlers = {};

  for (const [name, stats] of Object.entries(incomingBowlers)) {
    const key = cleanName(name, "", 48);
    if (!key) continue;
    bowlers[key] = normalizeBowler(stats, key);
  }

  const currentBowler = cleanName(source.currentBowler, "Bowler 1", 48);
  if (!bowlers[currentBowler]) {
    bowlers[currentBowler] = createDefaultBowler(currentBowler);
  }

  return {
    currentBowler,
    bowlers
  };
}

function normalizeTeam(team, fallbackName) {
  const name = cleanTeamName(team?.name, fallbackName);
  const runs = Math.max(0, toSafeInt(team?.runs, 0));
  const wickets = clampInt(team?.wickets, 0, MAX_WICKETS);
  const legalBallsRaw = toSafeInt(team?.legalBalls, -1);
  const legalBalls = legalBallsRaw >= 0 ? legalBallsRaw : overToBalls(team?.over);
  const over = ballsToOverNumber(legalBalls);

  const battingSource = typeof team?.batting === "object" && team.batting !== null ? team.batting : {};
  const striker = normalizeBatter(battingSource.striker, `${name} Batter 1`);
  let nonStriker = normalizeBatter(battingSource.nonStriker, `${name} Batter 2`);
  if (striker.name === nonStriker.name) {
    nonStriker.name = nonStriker.name.endsWith(" (NS)")
      ? nonStriker.name
      : `${nonStriker.name} (NS)`;
  }

  const nextBatsmanNumber = Math.max(3, toSafeInt(battingSource.nextBatsmanNumber, 3));

  const extrasWide = Math.max(0, toSafeInt(team?.extras?.wide, 0));
  const extrasNoBall = Math.max(0, toSafeInt(team?.extras?.noBall, 0));
  const extrasBye = Math.max(0, toSafeInt(team?.extras?.bye, 0));
  const extrasTotal = extrasWide + extrasNoBall + extrasBye;

  return {
    name,
    runs,
    wickets,
    over,
    legalBalls,
    extras: {
      wide: extrasWide,
      noBall: extrasNoBall,
      bye: extrasBye,
      total: extrasTotal
    },
    batting: {
      striker,
      nonStriker,
      nextBatsmanNumber
    },
    bowling: normalizeBowling(team?.bowling)
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

function hasInvalidTeamState(team) {
  if (!team || typeof team !== "object") return true;
  if (!Number.isFinite(team.runs) || team.runs < 0) return true;
  if (!Number.isFinite(team.wickets) || team.wickets < 0 || team.wickets > MAX_WICKETS) return true;
  if (!Number.isFinite(team.over) || team.over < 0) return true;
  if (!Number.isFinite(team.legalBalls) || team.legalBalls < 0) return true;
  if (team.legalBalls !== overToBalls(team.over)) return true;

  const striker = team?.batting?.striker;
  const nonStriker = team?.batting?.nonStriker;
  if (!striker || !nonStriker) return true;
  if (!striker.name || !nonStriker.name) return true;
  if (striker.name === nonStriker.name) return true;
  if (striker.runs < 0 || striker.balls < 0 || nonStriker.runs < 0 || nonStriker.balls < 0) return true;

  const extras = team?.extras;
  if (!extras) return true;
  if (extras.wide < 0 || extras.noBall < 0 || extras.bye < 0 || extras.total < 0) return true;
  if (extras.total !== extras.wide + extras.noBall + extras.bye) return true;

  const bowling = team?.bowling;
  if (!bowling || !bowling.currentBowler) return true;
  if (!bowling.bowlers || typeof bowling.bowlers !== "object") return true;
  if (!bowling.bowlers[bowling.currentBowler]) return true;

  return false;
}

function hasInvalidMatchState(state) {
  if (!state || typeof state !== "object") return true;
  if (state.activeTeam !== "teamA" && state.activeTeam !== "teamB") return true;
  if (hasInvalidTeamState(state.teamA)) return true;
  if (hasInvalidTeamState(state.teamB)) return true;
  return false;
}

function validateWinner(winner) {
  return winner === "teamA" || winner === "teamB";
}

function cleanTeamName(value, fallback) {
  return cleanName(value, fallback, 60);
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

    if (hasInvalidMatchState(incomingMatch)) {
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

  socket.conn.on("upgrade", (transport) => {
    console.log("Transport upgraded:", transport?.name);
  });

  // send current match on join
  socket.emit("matchUpdate", match);

  emitMatchesUpdate(socket);

  // backward compatibility
  socket.emit("scoreUpdate", match[match.activeTeam]);

  socket.on("joinMatch", () => {
    console.log("User joined match");
  });

  socket.on("updateMatch", async (data) => {
    try {
      if (!isAdminSocket(socket)) return;

      const nextMatch = normalizeMatchState(data);
      if (hasInvalidMatchState(nextMatch)) return;
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

      const nextTeam = normalizeTeam(
        {
          ...match[match.activeTeam],
          runs: data?.runs,
          wickets: data?.wickets,
          over: data?.over
        },
        match.activeTeam === "teamA" ? "Team A" : "Team B"
      );
      const nextMatch = {
        ...match,
        [match.activeTeam]: nextTeam
      };
      if (hasInvalidMatchState(nextMatch)) return;
      match = nextMatch;
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

      if (hasInvalidMatchState(incomingMatch)) {
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

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
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
