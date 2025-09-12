import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuid } from 'uuid';

const server = createServer((req, res) => {
  res.writeHead(200);
  res.end('WebRTC signaling server is running ✅');
});

const wss = new WebSocketServer({ server });

const rooms = new Map();   // roomId -> Set<ws>
const meta = new Map();    // ws -> { id, roomId }

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

wss.on('connection', (ws) => {
  const id = uuid();
  meta.set(ws, { id, roomId: null });
  console.log(`🔌 Client connected: ${id}`);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    const { type } = data;

    if (type === 'join') {
      const { roomId } = data;
      meta.get(ws).roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      console.log(`👥 ${id} joined room ${roomId}`);
      broadcastToRoom(roomId, ws, 'peer-joined', { peerId: id });
      return;
    }

    const roomId = meta.get(ws).roomId;
    if (!roomId || !rooms.has(roomId)) return;

    if (['offer', 'answer', 'candidate'].includes(type)) {
      broadcastToRoom(roomId, ws, type, { from: id, ...data });
    }

    if (type === 'leave') {
      leaveRoom(ws);
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    meta.delete(ws);
    console.log(`❌ Client disconnected: ${id}`);
  });
});

function broadcastToRoom(roomId, exceptWs, type, payload) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  for (const client of peers) {
    if (client !== exceptWs) send(client, type, payload);
  }
}

function leaveRoom(ws) {
  const info = meta.get(ws);
  if (!info) return;
  const { roomId, id } = info;
  if (!roomId) return;

  const peers = rooms.get(roomId);
  if (peers) {
    peers.delete(ws);
    if (peers.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastToRoom(roomId, ws, 'peer-left', { peerId: id });
    }
  }
  info.roomId = null;
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});
