import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

const server = createServer((req, res) => {
  res.writeHead(200);
  res.end("WebRTC & Chat signaling server ✅");
});

const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();         // roomId → Set(ws)
const meta = new Map();          // ws → { id, roomId, username, callerName }
const users = new Map();         // username → ws
const activeCalls = new Map();   // callId → { roomId, caller, callee }

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastToRoom(roomId, except, type, payload = {}) {
  const peers = rooms.get(roomId);
  if (!peers) return;

  for (const client of peers) {
    if (client !== except && client.readyState === client.OPEN) {
      send(client, type, payload);
    }
  }
}

function leaveRoom(ws) {
  const info = meta.get(ws);
  if (!info) return;

  const { roomId, username } = info;

  if (roomId && rooms.has(roomId)) {
    const peers = rooms.get(roomId);
    peers.delete(ws);
    if (peers.size === 0) rooms.delete(roomId);
    else broadcastToRoom(roomId, ws, "peer-left", { peerId: username });
  }

  info.roomId = null;

  if (username && users.get(username) === ws) {
    users.delete(username);
  }
}

wss.on("connection", (ws) => {
  const id = uuid();
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
    const info = meta.get(ws);

    // JOIN ---------------------------------------------------------------------
    if (type === "join") {
      const { roomId, username } = data;

      info.roomId = roomId;
      info.username = username ?? null;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      const oldSocket = users.get(username);
      if (oldSocket && oldSocket !== ws) {
        try { oldSocket.close(); } catch {}
      }
      users.set(username, ws);

      console.log(`👥 ${username} joined room ${roomId}`);

      broadcastToRoom(roomId, ws, "peer-joined", {
        peerId: username,
        username,
      });
      return;
    }

    // CHAT MESSAGE (Nová logika pre čet) ---------------------------------------
    if (type === "chat-message") {
      const { to, content, fromName } = data;
      
      console.log(`💬 Chat: ${info.username} -> ${to}: ${content}`);

      // Nájdeme socket príjemcu priamo v mape users
      const recipientWs = users.get(to);
      
      if (recipientWs) {
        send(recipientWs, "chat-message", {
          from: info.username,
          fromName: fromName || info.username,
          content: content,
          timestamp: new Date().toISOString()
        });
      } else {
        console.log(`⚠️ Príjemca ${to} nie je online, správa bude dostupná len v histórii.`);
      }
      return;
    }

    const { roomId, username } = info;
    if (!roomId || !rooms.has(roomId)) return;

    // CALL ---------------------------------------------------------------------
    if (type === "call") {
      const { callId, callerName } = data;
      
      info.callerName = callerName || info.username;
      
      const peers = [...rooms.get(roomId)];
      const calleeWs = peers.find((p) => p !== ws);
      const callee = calleeWs ? meta.get(calleeWs).username : null;
      
      activeCalls.set(callId, {
        roomId,
        caller: username,
        callee,
      });
      
      broadcastToRoom(roomId, ws, "incoming-call", {
        from: username,
        callerName: info.callerName,
        roomId,
        callId,
      });
      return;
    }

    // ACCEPT -------------------------------------------------------------------
    if (type === "accept") {
      const { callId } = data;
      broadcastToRoom(roomId, ws, "call-accepted", { from: username, callId });
      return;
    }

    // REJECT -------------------------------------------------------------------
    if (type === "reject") {
      const { callId } = data;
      console.log(`⛔ Call rejected by ${username} (${callId})`);

      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId,
      });

      activeCalls.delete(callId);
      return;
    }

    // HANGUP -------------------------------------------------------------------
    if (type === "hangup") {
      const { callId } = data;
      console.log(`🛑 Hangup from ${username} (${callId})`);

      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId,
      });

      activeCalls.delete(callId);
      return;
    }

    // OFFER / ANSWER / ICE -----------------------------------------------------
    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }

    // LEAVE --------------------------------------------------------------------
    if (type === "leave") {
      leaveRoom(ws);
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    meta.delete(ws);
    console.log("❌ Client disconnected:", id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Signaling & Chat Server running on :${PORT}/ws`));
