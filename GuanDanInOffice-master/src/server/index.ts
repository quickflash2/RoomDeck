import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import mime from 'mime-types';
import { RoomManager } from './room';
import { SnapshotStore } from './persistence';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const clientDirectory = path.resolve(__dirname, '../client');
const dataDirectory = path.resolve(process.env.GUANDAN_DATA_DIR || path.join(process.cwd(), 'data'));
const relativeDataPath = path.relative(clientDirectory, dataDirectory);
if (!relativeDataPath || (!relativeDataPath.startsWith(`..${path.sep}`) && relativeDataPath !== '..' && !path.isAbsolute(relativeDataPath))) {
  throw new Error('GUANDAN_DATA_DIR must be outside the public client directory.');
}

const roomManager = new RoomManager(io, new SnapshotStore(path.join(dataDirectory, 'rooms.json')));
const joining = new Set<Socket>();

app.get('/internal/roomdeck/rooms', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({ rooms: roomManager.getInternalRoomList() });
});

app.post('/internal/roomdeck/rooms/:roomId/close', (request, response) => {
  roomManager.forceClose(request.params.roomId);
  response.setHeader('Cache-Control', 'no-store');
  response.json({ closed: true });
});

app.use(express.static(clientDirectory, {
  setHeaders: (res, filePath) => {
    const mimeType = mime.lookup(filePath);
    if (mimeType) res.setHeader('Content-Type', mimeType);
  }
}));

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  socket.on('joinRoom', data => {
    if (joining.has(socket)) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      socket.emit('error', '请输入昵称和房间号');
      return;
    }
    const { playerName, roomId, launchToken } = data;
    if (!Object.prototype.hasOwnProperty.call(data, 'launchToken')) {
      roomManager.joinRoom(socket, playerName, roomId);
      return;
    }

    joining.add(socket);
    void (async () => {
      try {
        let session: { roomId: string; playerName: string; playerKey: string };
        try {
          const internalUrl = process.env.ROOMDECK_INTERNAL_URL;
          if (!internalUrl || typeof launchToken !== 'string') throw new Error('Invalid launch request');
          const response = await fetch(`${internalUrl}/api/v1/internal/guandan-exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RoomDeck-Request': '1' },
            body: JSON.stringify({ token: launchToken })
          });
          if (!response.ok) throw new Error('Launch exchange failed');
          const value: unknown = await response.json();
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid launch session');
          const exchanged = value as Record<string, unknown>;
          if (typeof exchanged.roomId !== 'string' || typeof exchanged.playerName !== 'string' || typeof exchanged.playerKey !== 'string') {
            throw new Error('Invalid launch session');
          }
          session = { roomId: exchanged.roomId, playerName: exchanged.playerName, playerKey: exchanged.playerKey };
        } catch {
          socket.emit('error', '无法验证房间会话');
          return;
        }
        roomManager.joinRoom(socket, session.playerName, session.roomId, session.playerKey, true);
      } finally {
        joining.delete(socket);
      }
    })();
  });
  socket.on('getRoomList', () => roomManager.handleGetRoomList(socket));
  socket.on('disconnect', () => roomManager.handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    roomManager.shutdown();
    process.exit(0);
  });
}
