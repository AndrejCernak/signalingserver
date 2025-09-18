import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

const server = createServer((req, res) => {
  res.writeHead(200);
  res.end("WebRTC signaling server ✅");
});

const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> Set<ws>
const meta = new Map();  // ws -> { id, roomId, username }
const users = new Map(); // username -> ws (aktuálny socket)

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastToRoom(roomId, exceptWs, type, payload = {}) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  for (const client of peers) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      send(client, type, payload);
    }
  }
}

function leaveRoom(ws) {
  const info = meta.get(ws);
  if (!info) return;
  const { roomId, username } = info;
  if (!roomId) return;

  const peers = rooms.get(roomId);
  if (peers) {
    peers.delete(ws);
    if (peers.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastToRoom(roomId, ws, "peer-left", { peerId: username });
    }
  }
  info.roomId = null;

  // ak je to aktuálny socket používateľa → vymaž ho
  if (username && users.get(username) === ws) {
    users.delete(username);
  }
}

wss.on("connection", (ws) => {
  const id = uuid(); // iba interné ID
  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const { type } = data;

    if (type === "join") {
      const { roomId, username } = data;
      meta.get(ws).roomId = roomId;
      meta.get(ws).username = username || null;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      // ✅ ak už tento user bol pripojený, zavri starý socket
      const old = users.get(username);
      if (old && old !== ws) {
        try { old.close(); } catch {}
      }

      // ✅ ulož aktuálny socket pre usera
      users.set(username, ws);

      console.log(`👥 ${username} joined room ${roomId}`);

      broadcastToRoom(roomId, ws, "peer-joined", {
        peerId: username,
        username,
      });

      return;
    }

    const info = meta.get(ws);
    const roomId = info.roomId;
    const username = info.username;
    if (!roomId || !rooms.has(roomId)) return;

    // VOLANIE
    if (type === "call") {
  const { callId, callerName } = data; // 👈 vytiahni aj callerName
  broadcastToRoom(roomId, ws, "incoming-call", {
    from: username,
    callerName: callerName || username, // 👈 teraz je definované
    roomId,
    callId,
  });
  return;
}


    if (type === "accept") {
      const { callId } = data;
      broadcastToRoom(roomId, ws, "call-accepted", {
        from: username,
        callId,
      });
      return;
    }

    if (type === "reject") {
      broadcastToRoom(roomId, ws, "call-rejected", { from: username });
      return;
    }

    if (type === "hangup") {
      broadcastToRoom(roomId, ws, "call-ended", { from: username });
      return;
    }

    // SDP/ICE
    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }

    if (type === "leave") {
      leaveRoom(ws);
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    meta.delete(ws);
    console.log("❌ Client disconnected:", id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Signaling on :${PORT}`));
