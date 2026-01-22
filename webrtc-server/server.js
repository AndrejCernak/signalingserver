import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

// -----------------------------------------------------------------------------
// HTTP SERVER
// -----------------------------------------------------------------------------
const server = createServer((req, res) => {
  res.writeHead(200);
  res.end("WebRTC & Chat signaling server ✅");
});

// -----------------------------------------------------------------------------
// WEBSOCKET SERVER
// -----------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------
const rooms = new Map();         // roomId → Set(ws)
const meta = new Map();          // ws → { id, roomId, username, callerName }
const users = new Map();         // username → ws
const activeCalls = new Map();   // callId → { roomId, caller, callee }

// 🔹 TEMP CHAT QUEUE (ACK-based)
const pendingMessages = new Map();
// username → Map(messageId → message)

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// CONNECTION
// -----------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // JOIN
    // -------------------------------------------------------------------------
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

      // 🔹 SEND PENDING MESSAGES (do NOT delete yet – wait for ACK)
      const queued = pendingMessages.get(username);
      if (queued) {
        for (const msg of queued.values()) {
          send(ws, "chat-message", msg);
        }
        console.log(`📤 Sent ${queued.size} queued messages to ${username}`);
      }

      return;
    }

    // -------------------------------------------------------------------------
    // CHAT MESSAGE
    // -------------------------------------------------------------------------
    if (type === "chat-message") {
      const {
        to,
        content,
        kind = "text",
        filename = null,
        messageId
      } = data;

      const from = info.username;

      const msg = {
        messageId,
        from,
        to,
        content,
        kind,
        filename,
        timestamp: new Date().toISOString()
      };

      const recipientWs = users.get(to);

      // 🔹 ONLINE → send immediately
      if (recipientWs) {
        send(recipientWs, "chat-message", msg);
      }

      // 🔹 ALWAYS store in queue until ACK
      if (!pendingMessages.has(to)) {
        pendingMessages.set(to, new Map());
      }
      pendingMessages.get(to).set(messageId, msg);

      console.log(`💬 ${from} → ${to} (${messageId}) queued`);

      return;
    }

    // -------------------------------------------------------------------------
    // CHAT ACK
    // -------------------------------------------------------------------------
    if (type === "chat-ack") {
      const { messageId } = data;
      const username = info.username;

      const queue = pendingMessages.get(username);
      if (queue && queue.has(messageId)) {
        queue.delete(messageId);
        console.log(`✅ ACK from ${username}, removed ${messageId}`);
        if (queue.size === 0) {
          pendingMessages.delete(username);
        }
      }

      return;
    }

    const { roomId, username } = info;
    if (!roomId || !rooms.has(roomId)) return;

    // -------------------------------------------------------------------------
    // CALL
    // -------------------------------------------------------------------------
    if (type === "call") {
      const { callId, callerName } = data;

      info.callerName = callerName || username;

      const peers = [...rooms.get(roomId)];
      const calleeWs = peers.find((p) => p !== ws);
      const callee = calleeWs ? meta.get(calleeWs).username : null;

      activeCalls.set(callId, { roomId, caller: username, callee });

      broadcastToRoom(roomId, ws, "incoming-call", {
        from: username,
        callerName: info.callerName,
        roomId,
        callId,
      });
      return;
    }

    // -------------------------------------------------------------------------
    // ACCEPT
    // -------------------------------------------------------------------------
    if (type === "accept") {
      broadcastToRoom(roomId, ws, "call-accepted", {
        from: username,
        callId: data.callId,
      });
      return;
    }

    // -------------------------------------------------------------------------
    // REJECT / HANGUP
    // -------------------------------------------------------------------------
    if (type === "reject" || type === "hangup") {
      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId: data.callId,
      });
      activeCalls.delete(data.callId);
      return;
    }

    // -------------------------------------------------------------------------
    // OFFER / ANSWER / ICE
    // -------------------------------------------------------------------------
    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }

    // -------------------------------------------------------------------------
    // LEAVE
    // ------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling & Chat Server running on :${PORT}/ws`)
);
