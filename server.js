const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const path = require("path");
const { initDb, insertMatch, getTeamNames, setTeamNames, listMatches } = require("./db");

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

const io = new Server(server, {
  // If WebSockets are blocked in production, Socket.IO will fall back to polling (often feels slower).
  // These settings keep defaults but make connectivity issues easier to spot and help detect dead clients sooner.
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.json());

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/client", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

app.get("/", (req, res) => {
  res.redirect("/client");
});

// serve frontend
app.use(express.static("public"));

let match = {
  activeTeam: "teamA",
  teamA: { name: "Team A", runs: 0, wickets: 0, over: 0.0 },
  teamB: { name: "Team B", runs: 0, wickets: 0, over: 0.0 }
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

function normalizeTeam(team, fallbackName) {
  const name = String(team?.name ?? fallbackName);
  const runs = Number(team?.runs ?? 0);
  const wickets = Number(team?.wickets ?? 0);
  const over = normalizeOver(team?.over);

  return {
    name: name || fallbackName,
    runs: Number.isFinite(runs) && runs >= 0 ? Math.floor(runs) : 0,
    wickets: Number.isFinite(wickets) && wickets >= 0 ? Math.floor(wickets) : 0,
    over
  };
}

function normalizeMatchState(state) {
  const activeTeam = state?.activeTeam === "teamB" ? "teamB" : "teamA";
  return {
    activeTeam,
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

app.put("/api/teams", async (req, res) => {
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
    const winner = req.body?.winner;
    if (!validateWinner(winner)) {
      return res.status(400).json({ ok: false, error: "Winner is required (teamA/teamB)." });
    }

    const incomingMatch = normalizeMatchState(req.body?.match ?? req.body);

    // Basic completeness validation
    if (!incomingMatch.teamA.name || !incomingMatch.teamB.name) {
      return res.status(400).json({ ok: false, error: "Team names are required." });
    }

    const saved = await insertMatch({ match: incomingMatch, winner });
    emitMatchesUpdate();
    return res.json({ ok: true, id: saved.id, createdAt: saved.createdAt });
  } catch (err) {
    console.error("Record match failed", err);
    return res.status(500).json({ ok: false, error: "Failed to record match." });
  }
});

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

  socket.on("updateMatch", (data) => {
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
  });

  // backward compatibility: update active team only
  socket.on("updateScore", (data) => {
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
