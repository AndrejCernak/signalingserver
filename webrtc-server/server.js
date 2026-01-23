import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/* ============================================================================
   HTTP SERVER
============================================================================ */
const server = createServer(async (req, res) => {
  // --------------------------------------------------
  // PRESIGNED S3 UPLOAD URL
  // --------------------------------------------------
  if (req.method === "POST" && req.url === "/upload-url") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const { filename, contentType } = JSON.parse(body);

        const key = `chat/${Date.now()}-${filename}`;

        const command = new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          ContentType: contentType
        });

        const uploadUrl = await getSignedUrl(s3, command, {
          expiresIn: 60
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            uploadUrl,
            fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
          })
        );
      } catch (err) {
        console.error("❌ upload-url error:", err);
        res.writeHead(500);
        res.end("error");
      }
    });
    return;
  }

  res.writeHead(200);
  res.end("WebRTC & Chat signaling server ✅");
});

/* ============================================================================
   AWS S3 CLIENT
============================================================================ */
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/* ============================================================================
   WEBSOCKET SERVER
============================================================================ */
const wss = new WebSocketServer({ server, path: "/ws" });

/* ============================================================================
   STATE
============================================================================ */
const rooms = new Map();           // roomId → Set(ws)
const meta = new Map();            // ws → { id, roomId, username, callerName }
const users = new Map();           // username → ws
const activeCalls = new Map();     // callId → { roomId, caller, callee }

// ACK-based chat queue
const pendingMessages = new Map(); // username → Map(messageId → message)

/* ============================================================================
   HELPERS
============================================================================ */
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

  if (username && users.get(username) === ws) {
    users.delete(username);
  }
}

/* ============================================================================
   CONNECTION
============================================================================ */
wss.on("connection", (ws) => {
  const id = uuid();
  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type } = data;
    const info = meta.get(ws);

    /* -----------------------------------------------------------------------
       JOIN
    ----------------------------------------------------------------------- */
    if (type === "join") {
      const { roomId, username } = data;

      info.roomId = roomId;
      info.username = username;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      const old = users.get(username);
      if (old && old !== ws) {
        try { old.close(); } catch {}
      }
      users.set(username, ws);

      console.log(`👥 ${username} joined room ${roomId}`);

      // send queued messages
      const queued = pendingMessages.get(username);
      if (queued) {
        for (const msg of queued.values()) {
          send(ws, "chat-message", msg);
        }
        console.log(`📤 Sent ${queued.size} queued messages to ${username}`);
      }
      return;
    }

    /* -----------------------------------------------------------------------
       CHAT MESSAGE
    ----------------------------------------------------------------------- */
    if (type === "chat-message") {
      const { to, content, kind = "text", filename = null, messageId } = data;
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
      if (recipientWs) {
        send(recipientWs, "chat-message", msg);
      }

      if (!pendingMessages.has(to)) {
        pendingMessages.set(to, new Map());
      }
      pendingMessages.get(to).set(messageId, msg);

      console.log(`💬 ${from} → ${to} (${messageId}) queued`);
      return;
    }

    /* -----------------------------------------------------------------------
       CHAT ACK
    ----------------------------------------------------------------------- */
    if (type === "chat-ack") {
      const { messageId } = data;
      const username = info.username;

      const queue = pendingMessages.get(username);
      if (queue && queue.has(messageId)) {
        queue.delete(messageId);
        console.log(`✅ ACK from ${username}, removed ${messageId}`);
        if (queue.size === 0) pendingMessages.delete(username);
      }
      return;
    }

    const { roomId, username } = info;
    if (!roomId || !rooms.has(roomId)) return;

    /* -----------------------------------------------------------------------
       CALLS (UNTOUCHED)
    ----------------------------------------------------------------------- */
    if (type === "call") {
      const { callId, callerName } = data;
      info.callerName = callerName || username;

      const peers = [...rooms.get(roomId)];
      const calleeWs = peers.find(p => p !== ws);
      const callee = calleeWs ? meta.get(calleeWs).username : null;

      activeCalls.set(callId, { roomId, caller: username, callee });

      broadcastToRoom(roomId, ws, "incoming-call", {
        from: username,
        callerName: info.callerName,
        roomId,
        callId
      });
      return;
    }

    if (type === "accept") {
      broadcastToRoom(roomId, ws, "call-accepted", {
        from: username,
        callId: data.callId
      });
      return;
    }

    if (type === "reject" || type === "hangup") {
      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId: data.callId
      });
      activeCalls.delete(data.callId);
      return;
    }

    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    meta.delete(ws);
    console.log("❌ Client disconnected:", id);
  });
});

/* ============================================================================
   START
============================================================================ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling & Chat Server running on :${PORT}`)
);
