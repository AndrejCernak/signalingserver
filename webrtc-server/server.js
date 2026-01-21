import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import fetch from "node-fetch";

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
const users = new Map();         // username (Clerk ID) → ws
const activeCalls = new Map();   // callId → { roomId, caller, callee }

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
// SAVE CHAT MESSAGE TO FRAPPE (ASYNC)
// -----------------------------------------------------------------------------
async function saveChatToFrappe({ from, to, content, roomId }) {
  try {
    const res = await fetch(
      "https://bcservices.f.frappe.cloud/api/method/bcservices.api.chat.save_message",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          from_clerk: from,
          to_clerk: to,
          content,
          room_id: roomId || "",
        }),
      }
    );

    const json = await res.json();
    console.log("💾 Chat saved to Frappe:", json);
  } catch (err) {
    console.error("❌ Failed to save chat to Frappe:", err);
  }
}

// -----------------------------------------------------------------------------
// CONNECTION
// -----------------------------------------------------------------------------
wss.on("connection", (ws) => {
  const id = uuid();
  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", async (msg) => {
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
      return;
    }

    // -------------------------------------------------------------------------
    // CHAT MESSAGE
    // -------------------------------------------------------------------------
    if (type === "chat-message") {
      const { to, content, fromName } = data;
      const from = info.username;
      const roomId = info.roomId;

      console.log(`💬 Chat: ${from} -> ${to}: ${content}`);

      // realtime delivery
      const recipientWs = users.get(to);
      if (recipientWs) {
        send(recipientWs, "chat-message", {
          from,
          fromName: fromName || from,
          content,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log(`⚠️ ${to} offline → message only in history`);
      }

      // async save to frappe
      saveChatToFrappe({
        from,
        to,
        content,
        roomId,
      });

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
    // -------------------------------------------------------------------------
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
