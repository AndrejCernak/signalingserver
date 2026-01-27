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

/* ============================================================================
   HTTP SERVER (UPLOAD / DOWNLOAD)
============================================================================ */
const server = createServer((req, res) => {
  // UPLOAD URL
  if (req.method === "POST" && req.url === "/upload-url") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { filename, contentType } = JSON.parse(body);
        const key = `chat/${Date.now()}-${safeFilename(filename)}`;
        console.log("📤 Upload URL:", key);
        const cmd = new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          ContentType: contentType
        });
        const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 });
        res.end(JSON.stringify({ uploadUrl, key }));
      } catch (e) {
        res.writeHead(500); res.end(e.toString());
      }
    });
    return;
  }

  // DOWNLOAD URL
  if (req.method === "POST" && req.url === "/download-url") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { key } = JSON.parse(body);
        console.log("📥 Download URL:", key);
        const cmd = new GetObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          ResponseContentDisposition: "attachment"
        });
        const downloadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
        res.end(JSON.stringify({ downloadUrl }));
      } catch (e) {
        res.writeHead(500); res.end(e.toString());
      }
    });
    return;
  }

  res.end("WebRTC & Chat signaling server ✅");
});

/* ============================================================================
   WEBSOCKET SERVER
============================================================================ */
const wss = new WebSocketServer({ server, path: "/ws" });

/* ============================================================================
   STATE
============================================================================ */
const rooms = new Map();            // roomId → Set(ws)
const meta = new Map();             // ws → { id, roomId, username, callerName }
const users = new Map();            // username → ws
const pendingMessages = new Map();  // username → Map(messageId → message)

// 🔥 OPRAVA: Pamäť pre čakajúce hovory (ak volajúci príde skôr ako volaný)
const pendingCalls = new Map();     // roomId → { callId, callerName, fromUsername }

/* ============================================================================
   WS CONNECTION
============================================================================ */
wss.on("connection", (ws) => {
  const id = uuid();
  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    const { type } = data;
    const info = meta.get(ws);

    // ------------------------------------------------------------------------
    // JOIN
    // ------------------------------------------------------------------------
    if (type === "join") {
      info.roomId = data.roomId;
      info.username = data.username;

      if (!rooms.has(info.roomId)) rooms.set(info.roomId, new Set());
      rooms.get(info.roomId).add(ws);

      // Register user globally for chat
      const old = users.get(info.username);
      if (old && old !== ws) try { old.close(); } catch {}
      users.set(info.username, ws);

      console.log(`👥 ${info.username} joined ${info.roomId}`);

      broadcastToRoom(info.roomId, ws, "peer-joined", {
        peerId: info.username,
        username: info.username
      });

      // 🔥 OPRAVA: Ak v tejto roomke čaká hovor (Pending Call), pošli ho tomuto userovi!
      if (pendingCalls.has(info.roomId)) {
        const callInfo = pendingCalls.get(info.roomId);
        // Neposielať späť volajúcemu, iba novému účastníkovi
        if (callInfo.fromUsername !== info.username) {
            console.log(`🚀 Sending pending call in ${info.roomId} to late joiner ${info.username}`);
            send(ws, "incoming-call", {
                from: callInfo.fromUsername,
                callerName: callInfo.callerName,
                roomId: info.roomId,
                callId: callInfo.callId
            });
        }
      }

      // Doručenie offline správ (Chat)
      const queue = pendingMessages.get(info.username);
      if (queue) {
        console.log(`📦 Delivering ${queue.size} queued messages`);
        for (const msg of queue.values()) {
          send(ws, "chat-message", msg);
        }
      }
      return;
    }

    const { roomId, username } = info;
    if (!roomId) return;

    // ------------------------------------------------------------------------
    // CALL SETUP
    // ------------------------------------------------------------------------
    if (type === "call") {
      info.callerName = data.callerName || username;

      // Zisti, či je v miestnosti niekto iný
      const peers = rooms.get(roomId);
      const otherPeers = [...peers].filter(p => p !== ws);

      // Ulož hovor do "čakárne", ak by sa volaný pripojil neskôr
      pendingCalls.set(roomId, {
          callId: data.callId,
          callerName: info.callerName,
          fromUsername: username
      });

      // Ak je už niekto v miestnosti, pošli mu to hneď
      if (otherPeers.length > 0) {
          broadcastToRoom(roomId, ws, "incoming-call", {
            from: username,
            callerName: info.callerName,
            roomId,
            callId: data.callId
          });
      } else {
          console.log(`⏳ Call stored for room ${roomId} (waiting for peer)`);
      }
      return;
    }

    if (type === "accept") {
      // Keď je hovor prijatý, vymažeme ho z čakárne
      pendingCalls.delete(roomId);

      broadcastToRoom(roomId, ws, "call-accepted", {
        from: username,
        callId: data.callId
      });
      return;
    }

    if (type === "reject" || type === "hangup") {
      pendingCalls.delete(roomId);
      
      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId: data.callId
      });
      return;
    }

    // ------------------------------------------------------------------------
    // WEBRTC SIGNALING
    // ------------------------------------------------------------------------
    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, {
        from: username,
        ...data
      });
      return;
    }

    // ------------------------------------------------------------------------
    // CHAT
    // ------------------------------------------------------------------------
    if (type === "chat-message") {
      const { to, content, kind, filename, messageId } = data;
      const msg = {
        messageId, from: username, to, content, kind, filename,
        timestamp: new Date().toISOString()
      };

      const recipient = users.get(to);
      if (recipient) send(recipient, "chat-message", msg);

      if (!pendingMessages.has(to)) pendingMessages.set(to, new Map());
      pendingMessages.get(to).set(messageId, msg);
      return;
    }

    if (type === "chat-ack") {
      const queue = pendingMessages.get(username);
      if (queue?.delete(data.messageId)) {
        if (queue.size === 0) pendingMessages.delete(username);
      }
      return;
    }

    if (type === "leave") {
      broadcastToRoom(roomId, ws, "peer-left", { peerId: username });
      rooms.get(roomId)?.delete(ws);
      users.delete(username);
      // Ak odíde volajúci, zruš pending call
      const pending = pendingCalls.get(roomId);
      if (pending && pending.fromUsername === username) {
          pendingCalls.delete(roomId);
      }
    }
  });

  ws.on("close", () => {
    const info = meta.get(ws);
    if (info?.roomId) {
      broadcastToRoom(info.roomId, ws, "peer-left", {
        peerId: info.username
      });
      rooms.get(info.roomId)?.delete(ws);
      
      // Cleanup pending calls if the caller disconnects
      const pending = pendingCalls.get(info.roomId);
      if (pending && pending.fromUsername === info.username) {
          pendingCalls.delete(info.roomId);
      }
    }
    users.delete(info?.username);
    meta.delete(ws);
    console.log("❌ Client disconnected:", id);
  });
});

/* ============================================================================
   START
============================================================================ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling + Chat + Calls running on :${PORT}`)
);
