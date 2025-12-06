// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// IMPORTANT: allow requests from your GitHub Pages URL
// For development, origin: "*" is fine.
// Later you can replace "*" with "https://your-username.github.io"
const io = new Server(server, {
  cors: {
    origin: "https://anusha-s-game.onrender.com/",
    methods: ["GET", "POST"],
  },
});

// Simple check route
app.get("/", (req, res) => {
  res.send("Chain Reaction backend is running.");
});

const ROWS = 9;
const COLS = 6;

function createEmptyBoard() {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ count: 0, owner: null }))
  );
}

function getMaxOrbs(row, col) {
  const isCorner =
    (row === 0 && col === 0) ||
    (row === 0 && col === COLS - 1) ||
    (row === ROWS - 1 && col === 0) ||
    (row === ROWS - 1 && col === COLS - 1);

  const isEdge = row === 0 || row === ROWS - 1 || col === 0 || col === COLS - 1;

  if (isCorner) return 2;
  if (isEdge) return 3;
  return 4;
}

function getNeighbors(row, col) {
  const neighbors = [];
  if (row > 0) neighbors.push([row - 1, col]);
  if (row < ROWS - 1) neighbors.push([row + 1, col]);
  if (col > 0) neighbors.push([row, col - 1]);
  if (col < COLS - 1) neighbors.push([row, col + 1]);
  return neighbors;
}

function applyMove(room, row, col, playerIndex) {
  const board = room.boardState;
  const cell = board[row][col];

  cell.owner = playerIndex;
  cell.count += 1;
  room.movesCount++;

  const queue = [{ row, col, player: playerIndex }];

  while (queue.length > 0) {
    const { row: r, col: c, player } = queue.shift();
    const currentCell = board[r][c];
    const maxOrbs = getMaxOrbs(r, c);

    if (currentCell.count >= maxOrbs) {
      currentCell.count -= maxOrbs;
      if (currentCell.count === 0) {
        currentCell.owner = null;
      }

      const neighbors = getNeighbors(r, c);
      for (const [nr, nc] of neighbors) {
        const nCell = board[nr][nc];
        nCell.count += 1;
        nCell.owner = player;
        queue.push({ row: nr, col: nc, player });
      }
    }
  }
}

function checkWinner(room) {
  const playersCount = Object.values(room.players).length;
  if (room.movesCount <= playersCount) return null;

  const ownersSet = new Set();
  let totalOrbs = 0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = room.boardState[r][c];
      if (cell.count > 0 && cell.owner !== null) {
        ownersSet.add(cell.owner);
        totalOrbs += cell.count;
      }
    }
  }

  if (totalOrbs === 0) return null;
  if (ownersSet.size === 1) {
    return ownersSet.values().next().value;
  }
  return null;
}

// roomId -> { boardState, currentPlayerIndex, gameOver, movesCount, players: {socketId:{index,name}} }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      boardState: createEmptyBoard(),
      currentPlayerIndex: 0,
      gameOver: false,
      movesCount: 0,
      players: {},
    });
  }
  return rooms.get(roomId);
}

function mapPlayersForClient(playersObj) {
  const result = [];
  for (const [socketId, p] of Object.entries(playersObj)) {
    result.push({
      socketId,
      index: p.index,
      name: p.name,
    });
  }
  return result;
}

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("join-room", ({ roomId, name }) => {
    roomId = (roomId || "").trim();
    name = (name || "Player").trim();

    if (!roomId) {
      socket.emit("join-error", { message: "Room ID is required." });
      return;
    }

    const room = getOrCreateRoom(roomId);
    const existingPlayers = Object.values(room.players);

    if (existingPlayers.length >= 2) {
      socket.emit("join-error", { message: "Room is full." });
      return;
    }

    const playerIndex =
      existingPlayers.length === 0 ? 0 : (existingPlayers[0].index + 1) % 2;

    room.players[socket.id] = { index: playerIndex, name };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = playerIndex;

    console.log(`Socket ${socket.id} joined room ${roomId} as P${playerIndex}`);

    socket.emit("joined", {
      roomId,
      playerIndex,
      name,
      rows: ROWS,
      cols: COLS,
      state: {
        boardState: room.boardState,
        currentPlayerIndex: room.currentPlayerIndex,
        gameOver: room.gameOver,
        movesCount: room.movesCount,
        winner: null,
        players: mapPlayersForClient(room.players),
      },
    });

    io.to(roomId).emit("room-update", {
      players: mapPlayersForClient(room.players),
    });
  });

  socket.on("make-move", ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const playerData = room.players[socket.id];
    if (!playerData) return;

    if (room.gameOver) {
      socket.emit("invalid-move", { message: "Game is already over." });
      return;
    }

    if (playerData.index !== room.currentPlayerIndex) {
      socket.emit("invalid-move", { message: "Not your turn." });
      return;
    }

    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) {
      socket.emit("invalid-move", { message: "Invalid cell." });
      return;
    }

    const cell = room.boardState[row][col];

    if (cell.owner !== null && cell.owner !== playerData.index) {
      socket.emit("invalid-move", {
        message: "You can only play on your own or empty cells.",
      });
      return;
    }

    applyMove(room, row, col, playerData.index);

    const winner = checkWinner(room);
    if (winner !== null) {
      room.gameOver = true;
    }

    if (!room.gameOver) {
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 2;
    }

    const stateForClients = {
      boardState: room.boardState,
      currentPlayerIndex: room.currentPlayerIndex,
      gameOver: room.gameOver,
      movesCount: room.movesCount,
      winner,
      players: mapPlayersForClient(room.players),
    };

    io.to(roomId).emit("state", stateForClients);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    delete room.players[socket.id];

    io.to(roomId).emit("room-update", {
      players: mapPlayersForClient(room.players),
    });

    if (Object.keys(room.players).length === 0) {
      rooms.delete(roomId);
    }

    console.log("Client disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
