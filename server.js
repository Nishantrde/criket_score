const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const MongoStore = require("connect-mongo");

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
  listAdminEmails,
  isAdminEmail,
  addAdminEmail,
  removeAdminEmail
} = require("./db");

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

app.set("trust proxy", 1);

const sessionSecret = process.env.SESSION_SECRET || "dev-session-secret";

const sessionStore =
  process.env.MONGODB_URI && process.env.SESSION_STORE !== "memory"
    ? MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: "sessions",
        ttl: 60 * 60 * 24 * 7
      })
    : undefined;

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  },
  store: sessionStore
});

app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback"
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const email = String(profile?.emails?.[0]?.value || "").trim().toLowerCase();
          if (!email) return done(null, false);
          return done(null, {
            email,
            name: profile?.displayName || "",
            picture: profile?.photos?.[0]?.value || ""
          });
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Login required." });
  return res.redirect("/login");
}

async function ensureAdmin(req, res, next) {
  try {
    if (!(req.isAuthenticated && req.isAuthenticated())) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Login required." });
      return res.redirect("/login");
    }
    const email = req.user?.email;
    if (!email) return res.status(403).json({ ok: false, error: "Forbidden." });
    const ok = await isAdminEmail(email);
    if (!ok) {
      if (req.path.startsWith("/api/")) return res.status(403).json({ ok: false, error: "Admin access required." });
      return res.status(403).send("Forbidden");
    }
    return next();
  } catch (err) {
    console.error("ensureAdmin failed", err);
    return res.status(500).json({ ok: false, error: "Auth check failed." });
  }
}

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/auth/google", (req, res, next) => {
  if (!passport._strategy("google")) {
    return res
      .status(500)
      .send("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!passport._strategy("google")) return res.redirect("/login");
    return passport.authenticate("google", { failureRedirect: "/login" })(req, res, next);
  },
  async (req, res) => {
    try {
      const email = req.user?.email;
      const admin = email ? await isAdminEmail(email) : false;
      return res.redirect(admin ? "/admin" : "/client");
    } catch (err) {
      console.error("Post-login redirect failed", err);
      return res.redirect("/client");
    }
  }
);

app.post("/auth/logout", ensureAuthenticated, (req, res) => {
  if (!req.logout) return res.json({ ok: true });
  req.logout((err) => {
    if (err) {
      console.error("Logout failed", err);
      return res.status(500).json({ ok: false, error: "Logout failed." });
    }
    req.session?.destroy(() => {
      res.clearCookie("connect.sid");
      return res.json({ ok: true });
    });
  });
});

app.get("/api/me", ensureAuthenticated, async (req, res) => {
  try {
    const email = req.user?.email;
    const admin = email ? await isAdminEmail(email) : false;
    return res.json({ ok: true, user: { email, name: req.user?.name || "", picture: req.user?.picture || "" }, isAdmin: admin });
  } catch (err) {
    console.error("/api/me failed", err);
    return res.status(500).json({ ok: false, error: "Failed to load session." });
  }
});

app.get("/admin", ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/client", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

// prevent direct HTML access bypassing the above route guards
app.get("/index.html", ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/client.html", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
});

app.get("/", async (req, res) => {
  if (!(req.isAuthenticated && req.isAuthenticated())) return res.redirect("/login");
  const email = req.user?.email;
  const admin = email ? await isAdminEmail(email) : false;
  return res.redirect(admin ? "/admin" : "/client");
});

// serve frontend
app.use(express.static("public"));

let match = {
  activeTeam: "teamA",
  winner: null,
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

app.get("/api/matches", async (req, res) => {
  try {
    if (!(req.isAuthenticated && req.isAuthenticated())) {
      return res.status(401).json({ ok: false, error: "Login required." });
    }
    const limit = Number.parseInt(req.query?.limit, 10);
    const matches = await listMatches({ limit: Number.isFinite(limit) ? limit : 5000 });
    return res.json({ ok: true, matches });
  } catch (err) {
    console.error("List matches failed", err);
    return res.status(500).json({ ok: false, error: "Failed to load match history." });
  }
});

app.put("/api/teams", ensureAdmin, async (req, res) => {
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
    if (!(req.isAuthenticated && req.isAuthenticated())) {
      return res.status(401).json({ ok: false, error: "Login required." });
    }
    const email = req.user?.email;
    if (!email || !(await isAdminEmail(email))) {
      return res.status(403).json({ ok: false, error: "Admin access required." });
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

app.delete("/api/matches", ensureAdmin, async (req, res) => {
  try {
    await clearMatches();
    emitMatchesUpdate();
    return res.json({ ok: true });
  } catch (err) {
    console.error("Clear matches failed", err);
    return res.status(500).json({ ok: false, error: "Failed to clear match history." });
  }
});

app.get("/api/admins", ensureAdmin, async (req, res) => {
  try {
    const admins = await listAdminEmails();
    return res.json({ ok: true, admins });
  } catch (err) {
    console.error("List admins failed", err);
    return res.status(500).json({ ok: false, error: "Failed to load admin list." });
  }
});

app.post("/api/admins", ensureAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@gmail\.com$/i.test(email)) {
      return res.status(400).json({ ok: false, error: "A valid Gmail address is required." });
    }
    await addAdminEmail(email);
    const admins = await listAdminEmails();
    return res.json({ ok: true, admins });
  } catch (err) {
    console.error("Add admin failed", err);
    return res.status(500).json({ ok: false, error: "Failed to add admin." });
  }
});

app.delete("/api/admins", ensureAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || req.query?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Email is required." });
    await removeAdminEmail(email);
    const admins = await listAdminEmails();
    return res.json({ ok: true, admins });
  } catch (err) {
    console.error("Remove admin failed", err);
    return res.status(500).json({ ok: false, error: "Failed to remove admin." });
  }
});

// Auth for sockets: require a logged-in user for all connections
function wrap(middleware) {
  return (socket, next) => {
    const res = {
      getHeader() {
        return undefined;
      },
      setHeader() {},
      end() {}
    };
    return middleware(socket.request, res, next);
  };
}

io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));
io.use((socket, next) => {
  if (socket.request?.user?.email) return next();
  return next(new Error("unauthorized"));
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

  socket.on("updateMatch", async (data) => {
    try {
      const userEmail = socket.request?.user?.email;
      if (!userEmail || !(await isAdminEmail(userEmail))) return;

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
      const userEmail = socket.request?.user?.email;
      if (!userEmail || !(await isAdminEmail(userEmail))) return;

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
