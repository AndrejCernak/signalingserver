import { WebSocketServer } from "ws";
import { createServer } from "http";
import https from "https"; // 🔥 PRIDANÉ: Import pre natívne HTTPS
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

const FRAPPE_NOTIFY_URL = "https://bcservices.f.frappe.cloud/api/method/bcservices.api.notify.send_notification";

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
    ws.send(JSON.stringify({ type, ...payload }), (err) => {
        if (err) console.error("⚠️ Send error:", err);
    });
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

// 🔥 OPRAVENÁ FUNKCIA: Používa natívne 'https' namiesto 'fetch'
function sendPushNotification(toUser, fromUser, fromName, content, kind) {
    console.log(`📡 Sending Push to ${toUser} from ${fromUser}...`);

    const data = JSON.stringify({
        "to_user": toUser,
        "from_user": fromUser,
        "from_name": fromName || "Niekto",
        "content": kind === 'file' ? "📎 Poslal vám súbor" : content
    });

    const url = new URL(FRAPPE_NOTIFY_URL);
    
    const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                console.log(`✅ Frappe notify Success (${res.statusCode}):`, responseBody);
            } else {
                console.error(`❌ Frappe notify Error (${res.statusCode}):`, responseBody);
            }
        });
    });

    req.on('error', (e) => {
        console.error(`❌ Frappe Request Failed: ${e.message}`);
    });

    // Write data to request body
    req.write(data);
    req.end();
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
const pendingCalls = new Map();     // roomId → { callId, callerName, fromUsername }

/* ============================================================================
   WS CONNECTION
============================================================================ */
wss.on("connection", (ws) => {
  const id = uuid();
  
  // 🔥 HEARTBEAT: Inicializácia
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", (raw) => {
    // 🔥 HEARTBEAT: Klient žije
    ws.isAlive = true;

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

      // Register user globally
      const old = users.get(info.username);
      if (old && old !== ws) {
          try { old.terminate(); } catch {}
      }
      users.set(info.username, ws);

      console.log(`👥 ${info.username} joined ${info.roomId}`);

      broadcastToRoom(info.roomId, ws, "peer-joined", {
        peerId: info.username,
        username: info.username
      });

      // Pending Calls
      if (pendingCalls.has(info.roomId)) {
        const callInfo = pendingCalls.get(info.roomId);
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

      // Offline Messages
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
      const peers = rooms.get(roomId);
      const otherPeers = [...peers].filter(p => p !== ws);

      pendingCalls.set(roomId, {
          callId: data.callId,
          callerName: info.callerName,
          fromUsername: username
      });

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
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }

    // ------------------------------------------------------------------------
    // CHAT (🔥 OPRAVENÉ)
    // ------------------------------------------------------------------------
    if (type === "chat-message") {
      const { to, content, kind, filename, messageId } = data;
      const msg = {
        messageId, from: username, to, content, kind, filename,
        timestamp: new Date().toISOString()
      };

      const recipient = users.get(to);
      let sentViaSocket = false;

      if (recipient && recipient.readyState === recipient.OPEN) {
        try {
            recipient.send(JSON.stringify({ type: "chat-message", ...msg }), (err) => {
                // Callback: zavolá sa, ak nastane chyba pri zápise do socketu
                if (err) {
                    console.log(`⚠️ Socket send failed for ${to}, falling back to Push.`);
                    sendPushNotification(to, username, info.username, content, kind);
                }
            });
            sentViaSocket = true;
        } catch (e) {
            console.error("Socket error sync:", e);
            sentViaSocket = false;
        }
      } 
      
      // Ak sme neposlali cez socket (alebo to zlyhalo synchrónne)
      if (!sentViaSocket) {
        sendPushNotification(to, username, info.username, content, kind);
      }

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
   🔥 HEARTBEAT (Ping/Pong)
============================================================================ */
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
       console.log("💀 Terminating inactive client");
       return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // 30 sekúnd

wss.on('close', function close() {
  clearInterval(interval);
});

/* ============================================================================
   START
============================================================================ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling + Chat + Calls running on :${PORT}`)
);
