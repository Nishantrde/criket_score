const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinMatch", (matchId) => {
    socket.join(matchId);
  });
});

function broadcastUpdate(matchId, data) {
  io.to(matchId).emit("scoreUpdate", data);
}

server.listen(3000, () => {
  console.log("Server running on 3000");
});