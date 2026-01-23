import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
   HTTP SERVER
============================================================================ */
const server = createServer(async (req, res) => {

  // -------------------------
  // UPLOAD URL
  // -------------------------
  if (req.method === "POST" && req.url === "/upload-url") {
    let body = "";

    req.on("data", chunk => body += chunk);
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
        res.end(JSON.stringify({
          uploadUrl,
          key
        }));
      } catch (err) {
        console.error("❌ upload-url error:", err);
        res.writeHead(500);
        res.end("error");
      }
    });
    return;
  }

  // -------------------------
  // DOWNLOAD URL
  // -------------------------
  if (req.method === "POST" && req.url === "/download-url") {
    let body = "";

    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { key } = JSON.parse(body);

        const command = new GetObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key
        });

        const downloadUrl = await getSignedUrl(s3, command, {
          expiresIn: 60 * 5
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ downloadUrl }));
      } catch (err) {
        console.error("❌ download-url error:", err);
        res.writeHead(500);
        res.end("error");
      }
    });
    return;
  }

  // -------------------------
  // DEFAULT
  // -------------------------
  res.writeHead(200);
  res.end("WebRTC & Chat signaling server ✅");
});

/* ============================================================================
   WEBSOCKET SERVER
============================================================================ */
const wss = new WebSocketServer({ server, path: "/ws" });

/* ============================================================================
   STATE
============================================================================ */
const rooms = new Map();
const meta = new Map();
const users = new Map();
const activeCalls = new Map();
const pendingMessages = new Map();

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
  }

  if (username && users.get(username) === ws) {
    users.delete(username);
  }
}

/* ============================================================================
   WS CONNECTION
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

    // JOIN
    if (type === "join") {
      const { roomId, username } = data;

      info.roomId = roomId;
      info.username = username;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      users.set(username, ws);

      const queued = pendingMessages.get(username);
      if (queued) {
        for (const msg of queued.values()) {
          send(ws, "chat-message", msg);
        }
      }
      return;
    }

    // CHAT MESSAGE
    if (type === "chat-message") {
      const { to, content, kind = "text", filename, messageId } = data;
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

      const recipient = users.get(to);
      if (recipient) send(recipient, "chat-message", msg);

      if (!pendingMessages.has(to)) pendingMessages.set(to, new Map());
      pendingMessages.get(to).set(messageId, msg);
      return;
    }

    // ACK
    if (type === "chat-ack") {
      const queue = pendingMessages.get(info.username);
      if (queue) queue.delete(data.messageId);
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
