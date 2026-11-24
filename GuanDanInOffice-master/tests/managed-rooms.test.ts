import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, TestContext } from 'node:test';
import { RoomManager, ServerSnapshot } from '../src/server/room';
import { SnapshotStore } from '../src/server/persistence';
import { GameMode } from '../src/shared/types';

type Listener = (...args: any[]) => void;

class FakeSocket {
  rooms = new Set<string>();
  listeners = new Map<string, Listener[]>();
  sent: { event: string; data: any }[] = [];

  constructor(public id: string, io: FakeIO) { io.sockets.push(this); }
  on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
  removeAllListeners(event: string) { this.listeners.delete(event); }
  emit(event: string, data?: any) { this.sent.push({ event, data }); }
  join(room: string) { this.rooms.add(room); }
  leave(room: string) { this.rooms.delete(room); }
  last(event: string) {
    const messages = this.sent.filter(message => message.event === event);
    return messages[messages.length - 1]?.data;
  }
}

class FakeIO {
  sockets: FakeSocket[] = [];
  to(room: string) {
    return { emit: (event: string, data?: any) => this.sockets.filter(socket => socket.rooms.has(room)).forEach(socket => socket.emit(event, data)) };
  }
}

function fixture() {
  const io = new FakeIO();
  const manager = new RoomManager(io as any);
  return { io, manager, socket: (id: string) => new FakeSocket(id, io) };
}

function snapshotStore(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-managed-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new SnapshotStore<ServerSnapshot>(path.join(directory, 'rooms.json'));
}

test('managed IDs reject direct joins before creation while validated launches stay isolated', () => {
  const { manager, socket } = fixture();
  const standalone = socket('standalone');
  manager.joinRoom(standalone as any, 'Public', 'public-room');

  const rejected = socket('rejected');
  manager.joinRoom(rejected as any, 'Attacker', 'rd_not-created');
  assert.equal(rejected.last('error'), '该房间需要有效的房间会话');
  assert.equal(manager.getInternalRoomList().some(room => room.id === 'rd_not-created'), false);
  manager.joinRoom(standalone as any, 'Public', 'rd_not-created');
  assert.ok(standalone.rooms.has('public-room'), 'a rejected switch must keep the old room');
  assert.equal(standalone.rooms.has('rd_not-created'), false);

  const first = socket('first');
  const second = socket('second');
  manager.joinRoom(first as any, 'Alice', 'rd_first', 'alice-key', true);
  manager.joinRoom(second as any, 'Bob', 'rd_second', 'bob-key', true);
  assert.equal(first.last('roomState').roomId, 'rd_first');
  assert.equal(second.last('roomState').roomId, 'rd_second');
  assert.equal(first.last('roomState').players.filter(Boolean).length, 1);
  assert.equal(second.last('roomState').players.filter(Boolean).length, 1);

  assert.deepEqual(manager.getRoomList(), [{
    id: 'public-room', playerCount: 1, maxPlayers: 4, inGame: false,
    gameMode: GameMode.Normal, hostName: 'Public'
  }]);
  const internal = manager.getInternalRoomList();
  assert.equal(internal.length, 3);
  assert.deepEqual(new Map(internal.map(room => [room.id, room.managed])), new Map([
    ['public-room', false], ['rd_first', true], ['rd_second', true]
  ]));
  assert.equal(internal.find(room => room.id === 'rd_first')?.hostName, 'Alice');
  assert.equal(internal.find(room => room.id === 'rd_second')?.hostName, 'Bob');
});

test('managed flags survive snapshots and protect non-prefixed legacy native IDs after restart', context => {
  const store = snapshotStore(context);
  const io = new FakeIO();
  const manager = new RoomManager(io as any, store);
  const original = new FakeSocket('original', io);
  manager.joinRoom(original as any, 'Alice', 'legacy-native', 'stable-key', true);
  const prefixed = new FakeSocket('prefixed', io);
  manager.joinRoom(prefixed as any, 'Bob', 'rd_prefixed', 'bob-key', true);
  const saved = store.load()!;
  assert.equal(saved.rooms.find(room => room.id === 'legacy-native')?.managed, true);
  assert.equal(saved.rooms.find(room => room.id === 'rd_prefixed')?.managed, true);

  const restoredIO = new FakeIO();
  const restored = new RoomManager(restoredIO as any, store);
  const rejected = new FakeSocket('rejected', restoredIO);
  restored.joinRoom(rejected as any, 'Attacker', 'legacy-native');
  assert.equal(rejected.last('error'), '该房间需要有效的房间会话');
  assert.equal(rejected.last('roomState'), undefined);
  assert.equal(restored.getInternalRoomList().find(room => room.id === 'legacy-native')?.playerCount, 1);
  assert.deepEqual(restored.getRoomList(), [], 'restored managed rooms remain hidden');

  const reconnected = new FakeSocket('reconnected', restoredIO);
  restored.joinRoom(reconnected as any, 'Alice', 'legacy-native', 'stable-key', true);
  assert.equal(reconnected.last('error'), undefined);
  assert.equal(reconnected.last('roomState').players[0].id, 'reconnected');
  assert.equal(reconnected.last('roomState').players[0].isDisconnected, false);
});

test('legacy RoomDeck snapshots infer managed rooms from stable player keys', context => {
  const store = snapshotStore(context);
  store.save({ version: 1, rooms: [{
    id: 'old-roomdeck-native', gameMode: GameMode.Normal,
    players: [{ id: 'old-id', name: 'Old player', playerKey: 'stable-key', seatIndex: 0, isReady: true, isHost: true }, null, null, null],
    match: null
  }] });
  const io = new FakeIO();
  const manager = new RoomManager(io as any, store);
  assert.equal(manager.getInternalRoomList()[0]?.managed, true);
  assert.deepEqual(manager.getRoomList(), []);
  const socket = new FakeSocket('attacker', io);
  manager.joinRoom(socket as any, 'Attacker', 'old-roomdeck-native');
  assert.equal(socket.last('error'), '该房间需要有效的房间会话');
  assert.equal(socket.last('roomState'), undefined);
});

test('legacy snapshots without managed remain public and are saved with an explicit false marker', context => {
  const store = snapshotStore(context);
  store.save({ version: 1, rooms: [{
    id: 'old-public', gameMode: GameMode.Normal,
    players: [{ id: 'old-id', name: 'Old player', seatIndex: 0, isReady: true, isHost: true }, null, null, null],
    match: null
  }] });
  const io = new FakeIO();
  const manager = new RoomManager(io as any, store);
  assert.equal(manager.getRoomList()[0]?.id, 'old-public');
  assert.equal(manager.getInternalRoomList()[0]?.managed, false);
  assert.equal(store.load()!.rooms[0].managed, false);
  const socket = new FakeSocket('new-id', io);
  manager.joinRoom(socket as any, 'Old player', 'old-public');
  assert.equal(socket.last('error'), undefined);
  assert.equal(socket.last('roomState').players[0].name, 'Old player');
});

test('RoomDeck force close terminates only the target managed table and removes its players', () => {
  const { manager, socket } = fixture();
  const first = socket('first-close');
  const second = socket('second-close');
  const publicSocket = socket('public-close');
  manager.joinRoom(first as any, 'Alice', 'rd_close-first', 'alice-key', true);
  manager.joinRoom(second as any, 'Bob', 'rd_close-second', 'bob-key', true);
  manager.joinRoom(publicSocket as any, 'Public', 'public-close', undefined, false);
  const start = first.listeners.get('start')?.[0];
  assert.ok(start);
  start!();
  assert.equal(manager.getInternalRoomList().find(room => room.id === 'rd_close-first')?.inGame, true);

  manager.forceClose('public-close');
  assert.equal(publicSocket.sent.some(message => message.event === 'leftRoom'), false);
  manager.forceClose('rd_close-first');
  assert.ok(first.sent.some(message => message.event === 'gameTerminated'));
  assert.ok(first.sent.some(message => message.event === 'leftRoom'));
  assert.equal(first.rooms.has('rd_close-first'), false);
  assert.equal(first.listeners.has('start'), false);
  assert.equal(second.sent.some(message => message.event === 'leftRoom'), false);
  assert.equal(second.rooms.has('rd_close-second'), true);
  const rooms = manager.getInternalRoomList();
  assert.equal(rooms.some(room => room.id === 'rd_close-first'), false);
  assert.equal(rooms.some(room => room.id === 'rd_close-second'), true);
  assert.equal(rooms.some(room => room.id === 'public-close'), true);
  manager.forceClose('rd_missing');
});
