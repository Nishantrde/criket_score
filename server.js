const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const path = require("path");

const io = new Server(server, {
  // If WebSockets are blocked in production, Socket.IO will fall back to polling (often feels slower).
  // These settings keep defaults but make connectivity issues easier to spot and help detect dead clients sooner.
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  pingInterval: 10000,
  pingTimeout: 5000
});

// serve frontend
app.use(express.static("public"));

app.get("/client", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "client.html"));
})


let score = {
  runs: 0,
  wickets: 0,
  over: 0.0
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

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  console.log("Transport:", socket.conn.transport?.name);

  socket.conn.on("upgrade", (transport) => {
    console.log("Transport upgraded:", transport?.name);
  });

  // send current score on join
  socket.emit("scoreUpdate", score);

  socket.on("joinMatch", () => {
    console.log("User joined match");
  });

  socket.on("updateScore", (data) => {
    score = {
      runs: Number(data?.runs ?? 0) || 0,
      wickets: Number(data?.wickets ?? 0) || 0,
      over: normalizeOver(data?.over)
    };

    // broadcast to all users
    io.emit("scoreUpdate", score);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
