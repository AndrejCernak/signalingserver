import { WebSocketServer } from "ws";
import { createServer } from "http";
import https from "https";
import { v4 as uuid } from "uuid";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const FRAPPE_NOTIFY_URL = "https://bcservices.f.frappe.cloud/api/method/bcservices.api.notify.send_notification";

function safeFilename(name) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]/g, "_");
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

function sendPushNotification(toUser, fromUser, fromName, content, kind) {
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
        console.log(`✅ Frappe notify Success (${res.statusCode})`);
      } else {
        console.error(`❌ Frappe notify Error (${res.statusCode}):`, responseBody);
      }
    });
  });

  req.on('error', (e) => console.error(`❌ Frappe Request Failed: ${e.message}`));
  req.write(data);
  req.end();
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/upload-url") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { filename, contentType } = JSON.parse(body);
        const key = `chat/${Date.now()}-${safeFilename(filename)}`;
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

  if (req.method === "POST" && req.url === "/download-url") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { key } = JSON.parse(body);
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

  // Health check endpoint pre keep-alive ping z externého servisu
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    return;
  }

  res.end("WebRTC & Chat signaling server ✅");
});

const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();
const meta = new Map();
const users = new Map();
const pendingMessages = new Map();
const pendingCalls = new Map();
// 🔥 NEW: queue pre accept signály ak caller ešte nie je v roomu keď callee accepts
const pendingAccepts = new Map();

wss.on("connection", (ws) => {
  const id = uuid();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  meta.set(ws, { id, roomId: null, username: null });
  console.log("🔌 Client connected:", id);

  ws.on("message", (raw) => {
    ws.isAlive = true;

    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    const { type } = data;
    const info = meta.get(ws);

    // Application-level ping/pong handler
    if (type === "ping") {
      send(ws, "pong", { timestamp: data.timestamp });
      return;
    }

    if (type === "join") {
      info.roomId = data.roomId;
      info.username = data.username;

      if (!rooms.has(info.roomId)) rooms.set(info.roomId, new Set());
      rooms.get(info.roomId).add(ws);

      const old = users.get(info.username);
      if (old && old !== ws) {
        try { old.terminate(); } catch {}
      }
      users.set(info.username, ws);

      console.log(`👥 ${info.username} joined ${info.roomId}`);

      send(ws, "joined", { roomId: info.roomId, username: info.username });

      broadcastToRoom(info.roomId, ws, "peer-joined", {
        peerId: info.username,
        username: info.username
      });

      if (pendingCalls.has(info.roomId)) {
        const callInfo = pendingCalls.get(info.roomId);
        if (callInfo.fromUsername !== info.username) {
          send(ws, "incoming-call", {
            from: callInfo.fromUsername,
            callerName: callInfo.callerName,
            roomId: info.roomId,
            callId: callInfo.callId
          });
        }
      }

      // 🔥 NEW: Replay queued accept ak existuje (caller pripojil neskôr ako accept prišiel)
      if (pendingAccepts.has(info.roomId)) {
        const accept = pendingAccepts.get(info.roomId);
        if (accept.fromUsername !== info.username) {
          console.log(`📤 Replaying queued accept for room=${info.roomId} to ${info.username}`);
          send(ws, "call-accepted", {
            from: accept.fromUsername,
            callId: accept.callId
          });
          pendingAccepts.delete(info.roomId);
        }
      }

      const queue = pendingMessages.get(info.username);
      if (queue) {
        for (const msg of queue.values()) {
          send(ws, "chat-message", msg);
        }
      }
      return;
    }

    const { roomId, username } = info;
    if (!roomId) return;

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
      }
      return;
    }

    // 🔥 NEW: Robust accept handler — queue ak caller v roomu nie je
    if (type === "accept") {
      pendingCalls.delete(roomId);

      const peers = rooms.get(roomId);
      const otherPeers = peers ? [...peers].filter(p => p !== ws) : [];

      if (otherPeers.length > 0) {
        broadcastToRoom(roomId, ws, "call-accepted", {
          from: username,
          callId: data.callId
        });
        console.log(`✅ Accept delivered for room=${roomId}`);
      } else {
        console.log(`📥 Queueing accept for room=${roomId} (caller not present)`);
        pendingAccepts.set(roomId, {
          callId: data.callId,
          fromUsername: username,
          timestamp: Date.now()
        });

        // Auto-cleanup po 30s
        const ts = Date.now();
        setTimeout(() => {
          const stored = pendingAccepts.get(roomId);
          if (stored && stored.timestamp === ts) {
            pendingAccepts.delete(roomId);
            console.log(`🗑️ Expired queued accept for room=${roomId}`);
          }
        }, 30000);
      }
      return;
    }

    if (type === "reject" || type === "hangup") {
      pendingCalls.delete(roomId);
      pendingAccepts.delete(roomId); // 🔥 NEW: cleanup pending accept on hangup
      broadcastToRoom(roomId, ws, "call-ended", {
        from: username,
        callId: data.callId
      });
      return;
    }

    if (["offer", "answer", "candidate"].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: username, ...data });
      return;
    }

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
            if (err) sendPushNotification(to, username, info.username, content, kind);
          });
          sentViaSocket = true;
        } catch (e) {
          sentViaSocket = false;
        }
      }

      if (!sentViaSocket) {
        sendPushNotification(to, username, info.username, content, kind);
      }

      if (!pendingMessages.has(to)) pendingMessages.set(to, new Map());
      pendingMessages.get(to).set(messageId, msg);
      return;
    }

    if (type === "chat-edit") {
      const { to, messageId, content } = data;
      const recipient = users.get(to);
      if (recipient && recipient.readyState === recipient.OPEN) {
        recipient.send(JSON.stringify({
          type: "chat-edit", from: username, to, messageId, content
        }));
      }
      return;
    }

    if (type === "chat-delete") {
      const { to, messageId } = data;
      const recipient = users.get(to);
      if (recipient && recipient.readyState === recipient.OPEN) {
        recipient.send(JSON.stringify({
          type: "chat-delete", from: username, to, messageId
        }));
      }
      return;
    }

    if (type === "chat-reaction") {
      const { to, messageId, emoji } = data;
      const recipient = users.get(to);
      if (recipient && recipient.readyState === recipient.OPEN) {
        const payload = {
          type: "chat-reaction", from: username, to, messageId
        };
        if (emoji) payload.emoji = emoji;
        recipient.send(JSON.stringify(payload));
      }
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
      // 🔥 NEW: cleanup queued accept
      const pendingA = pendingAccepts.get(roomId);
      if (pendingA && pendingA.fromUsername === username) {
        pendingAccepts.delete(roomId);
      }
    }
  });

  ws.on("close", () => {
    const info = meta.get(ws);
    if (info?.roomId) {
      broadcastToRoom(info.roomId, ws, "peer-left", { peerId: info.username });
      rooms.get(info.roomId)?.delete(ws);
      const pending = pendingCalls.get(info.roomId);
      if (pending && pending.fromUsername === info.username) {
        pendingCalls.delete(info.roomId);
      }
      // 🔥 NEW: cleanup queued accept
      const pendingA = pendingAccepts.get(info.roomId);
      if (pendingA && pendingA.fromUsername === info.username) {
        pendingAccepts.delete(info.roomId);
      }
    }
    users.delete(info?.username);
    meta.delete(ws);
    console.log("❌ Client disconnected:", id);
  });
});

const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling + Chat + Calls running on :${PORT}`)
);
