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
   HELPERS
============================================================================ */
function safeFilename(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

/* ============================================================================
   HTTP SERVER (UPLOAD / DOWNLOAD)
============================================================================ */
const server = createServer((req, res) => {

  // --------------------------------------------------------------------------
  // UPLOAD URL
  // --------------------------------------------------------------------------
  if (req.method === "POST" && req.url === "/upload-url") {
    let body = "";

    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { filename, contentType } = JSON.parse(body);

        const safeName = safeFilename(filename);
        const key = `chat/${Date.now()}-${safeName}`;

        console.log("📤 Upload requested:", key);

        const command = new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          ContentType: contentType
        });

        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ uploadUrl, key }));

      } catch (err) {
        console.error("❌ upload-url error:", err);
        res.writeHead(500).end("error");
      }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // DOWNLOAD URL
  // --------------------------------------------------------------------------
  if (req.method === "POST" && req.url === "/download-url") {
    let body = "";

    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { key } = JSON.parse(body);

        console.log("📥 Download requested:", key);

        const command = new GetObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          ResponseContentDisposition: "attachment"
        });

        const downloadUrl = await getSignedUrl(s3, command, {
          expiresIn: 60 * 5
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ downloadUrl }));

      } catch (err) {
        console.error("❌ download-url error:", err);
        res.writeHead(500).end("error");
      }
    });
    return;
  }

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
const rooms = new Map();            // roomId -> Set(ws)
const meta = new Map();             // ws -> { id, roomId, username }
const users = new Map();            // username -> ws
const pendingMessages = new Map();  // username -> Map(messageId -> message)

/* ============================================================================
   HELPERS
============================================================================ */
function send(ws, type, payload = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

/* ============================================================================
   WS CONNECTION
============================================================================ */
wss.on("connection", (ws) => {
  const id = uuid();
  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 WS connected:", id);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type } = data;
    const info = meta.get(ws);

    // ------------------------------------------------------------------------
    // JOIN
    // ------------------------------------------------------------------------
    if (type === "join") {
      const { roomId, username } = data;

      info.roomId = roomId;
      info.username = username;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      users.set(username, ws);

      console.log(`👤 ${username} joined ${roomId}`);

      const queue = pendingMessages.get(username);
      if (queue) {
        console.log(`📦 Delivering ${queue.size} queued messages to ${username}`);
        for (const msg of queue.values()) {
          send(ws, "chat-message", msg);
        }
      }
      return;
    }

    // ------------------------------------------------------------------------
    // CHAT MESSAGE
    // ------------------------------------------------------------------------
    if (type === "chat-message") {
      const { to, content, kind, filename, messageId } = data;
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

      console.log(`💬 ${from} → ${to} (${kind})`);

      const recipient = users.get(to);

      if (recipient) {
        send(recipient, "chat-message", msg);
        console.log("📨 Delivered live");
      } else {
        console.log("📦 Recipient offline, queued");
      }

      if (!pendingMessages.has(to)) {
        pendingMessages.set(to, new Map());
      }
      pendingMessages.get(to).set(messageId, msg);

      console.log(`📊 Queue size for ${to}: ${pendingMessages.get(to).size}`);
      return;
    }

    // ------------------------------------------------------------------------
    // ACK
    // ------------------------------------------------------------------------
    if (type === "chat-ack") {
      const { messageId } = data;
      const user = info.username;

      const queue = pendingMessages.get(user);
      if (queue && queue.has(messageId)) {
        queue.delete(messageId);
        console.log(`✅ ACK from ${user} for ${messageId}`);

        if (queue.size === 0) {
          pendingMessages.delete(user);
          console.log(`🧹 Queue cleared for ${user}`);
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    const info = meta.get(ws);
    if (info?.username) {
      users.delete(info.username);
      console.log(`❌ ${info.username} disconnected`);
    }
    meta.delete(ws);
  });
});

/* ============================================================================
   START
============================================================================ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling & Chat Server running on :${PORT}`)
);
