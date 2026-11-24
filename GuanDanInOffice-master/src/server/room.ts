import { Server, Socket } from 'socket.io';
import { Match, MatchSnapshot } from './match';
import { GameMode } from '../shared/types';
import { SnapshotStore } from './persistence';
import { validateSnapshot } from './snapshotValidation';

export interface Player {
  id: string;
  name: string;
  playerKey?: string;
  socket?: Socket;
  seatIndex: number;
  isReady: boolean;
  isBot?: boolean;
  isHost?: boolean;
  isDisconnected?: boolean;
}

export type SnapshotPlayer = Omit<Player, 'socket'>;

export interface ServerSnapshot {
  version: 1;
  rooms: {
    id: string;
    gameMode: GameMode;
    players: (SnapshotPlayer | null)[];
    match: MatchSnapshot | null;
    managed?: boolean;
  }[];
}

export const isRoomDeckManagedRoom = (id: string) => id.startsWith('rd_');

export class RoomManager {
  private io: Server;
  private rooms: Map<string, Room> = new Map();

  constructor(io: Server, private store?: SnapshotStore<ServerSnapshot>) {
    this.io = io;
    const snapshot = store?.load();
    if (snapshot != null) {
      validateSnapshot(snapshot);
      for (const saved of snapshot.rooms) {
        const room = this.createRoom(saved.id, saved.managed === true || isRoomDeckManagedRoom(saved.id) || saved.players.some(player => player?.playerKey !== undefined));
        room.gameMode = saved.gameMode;
        room.players = saved.players.map(player => player ? {
          id: player.id,
          name: player.name,
          playerKey: player.playerKey,
          seatIndex: player.seatIndex,
          isReady: false,
          isBot: !!player.isBot,
          isHost: !!player.isHost,
          isDisconnected: !player.isBot
        } : null);
        if (saved.match) {
          room.match = new Match(io, room.id, room.players as Player[], room.gameMode);
          room.bindMatch();
          room.match.restore(saved.match);
        }
      }
    }
    this.persist();
  }

  private createRoom(id: string, managed = isRoomDeckManagedRoom(id)): Room {
    const room = new Room(id, this.io, managed);
    room.onChange = () => this.persist();
    room.onEmpty = () => { this.rooms.delete(id); this.persist(); };
    this.rooms.set(id, room);
    return room;
  }

  snapshot(): ServerSnapshot {
    return {
      version: 1,
      rooms: [...this.rooms.values()].filter(room => !room.isEmpty()).map(room => ({
        id: room.id,
        managed: room.managed,
        gameMode: room.gameMode,
        players: room.players.map(player => player ? {
          id: player.id,
          name: player.name,
          playerKey: player.playerKey,
          seatIndex: player.seatIndex,
          isReady: player.isReady,
          isBot: !!player.isBot,
          isDisconnected: !!player.isDisconnected,
          isHost: !!player.isHost
        } : null),
        match: room.match?.snapshot() ?? null
      }))
    };
  }

  private persist() {
    this.store?.save(this.snapshot());
  }

  shutdown() {
    this.persist();
    for (const room of this.rooms.values()) room.match?.forceEndMatch();
  }

  joinRoom(socket: Socket, rawPlayerName: unknown, rawRoomId: unknown, playerKey?: string, managed = false) {
    const playerName = typeof rawPlayerName === 'string' ? rawPlayerName.trim() : '';
    if (!playerName || playerName.length > 20) {
      socket.emit('error', '昵称须为 1–20 个字符');
      return;
    }
    if (rawRoomId != null && typeof rawRoomId !== 'string') {
      socket.emit('error', '房间号格式不正确');
      return;
    }
    const roomId = (typeof rawRoomId === 'string' ? rawRoomId.trim() : '') || 'default';
    if (roomId.length > 40) {
      socket.emit('error', '房间号不能超过 40 个字符');
      return;
    }

    const destination = this.rooms.get(roomId);
    if (!managed && (destination?.managed || isRoomDeckManagedRoom(roomId))) {
      socket.emit('error', '该房间需要有效的房间会话');
      return;
    }
    if (destination && !destination.hasSocket(socket)) {
      const error = destination.getJoinError(playerName, playerKey);
      if (error) {
        socket.emit('error', error);
        return;
      }
    }
    for (const [id, existing] of this.rooms) {
      if (!existing.hasSocket(socket)) continue;
      if (id === roomId) {
        socket.emit('error', '你已经在这个房间里');
        return;
      }
      existing.leave(socket);
    }

    let room = this.rooms.get(roomId);
    if (!room) room = this.createRoom(roomId, managed);
    if (managed && !room.managed) {
      room.managed = true;
      this.persist();
    }
    room.addPlayer(socket, playerName, playerKey);
    if (room.isEmpty()) this.rooms.delete(roomId);
  }

  forceClose(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room?.managed) room.forceClose();
  }

  handleDisconnect(socket: Socket) {
    for (const [id, room] of [...this.rooms.entries()]) {
      room.handleDisconnect(socket);
      if (room.isEmpty()) this.rooms.delete(id);
    }
  }

  getRoomList() {
    return this.getInternalRoomList().filter(room => !room.managed).map(({ managed, ...room }) => room);
  }

  getInternalRoomList() {
    return Array.from(this.rooms.values()).filter(room => !room.isEmpty()).map(room => ({
      id: room.id,
      playerCount: room.players.filter(player => player !== null).length,
      maxPlayers: 4,
      inGame: !!(room.match && room.match.currentGame && room.match.matchWinner === null),
      gameMode: room.gameMode,
      hostName: room.players.find(player => player && player.isHost)?.name || '未知',
      managed: room.managed
    }));
  }

  handleGetRoomList(socket: Socket) {
    socket.emit('roomList', this.getRoomList());
  }
}

class Room {
  players: (Player | null)[] = [null, null, null, null];
  match: Match | null = null;
  gameMode: GameMode = GameMode.Normal;
  onEmpty?: () => void;
  onChange?: () => void;
  private roomEventNames = ['ready', 'start', 'chatMessage', 'switchSeat', 'setGameMode', 'forceEndGame', 'leaveRoom'];

  constructor(public id: string, public io: Server, public managed = false) {}

  isEmpty() { return this.players.every(player => player === null); }
  hasSocket(socket: Socket) { return this.players.some(player => player && player.socket === socket); }

  findPlayerIndex(name: string, playerKey?: string) {
    return this.players.findIndex(player => {
      if (!player) return false;
      if (playerKey !== undefined) return player.playerKey === playerKey;
      return player.name === name && (player.playerKey === undefined || player.isDisconnected === true);
    });
  }

  getJoinError(name: string, playerKey?: string): string | null {
    const existing = this.players[this.findPlayerIndex(name, playerKey)];
    if (existing) return existing.isDisconnected ? null : '这个名字已经在房间里';
    return this.players.every(player => player !== null) ? '房间已满' : null;
  }

  addPlayer(socket: Socket, name: string, playerKey?: string) {
    const existingPlayerIndex = this.findPlayerIndex(name, playerKey);
    if (existingPlayerIndex !== -1) {
      const player = this.players[existingPlayerIndex]!;
      if (!player.isDisconnected) {
        socket.emit('error', '这个名字已经在房间里');
        return;
      }
      player.isDisconnected = false;
      player.id = socket.id;
      player.name = name;
      player.socket = socket;
      socket.join(this.id);
      this.bindSocketListeners(socket);
      this.broadcastState();
      let recovering = false;
      if (this.match?.currentGame) {
        const game = this.match.currentGame;
        game.rebindPlayer(player);
        game.sendStateTo(player);
        recovering = this.match.resumeAfterRestart();
      }
      this.io.to(this.id).emit('notice', recovering
        ? '已恢复重启前的牌局；真人现在可操作，15 秒后机器人及未重连玩家恢复托管'
        : `${name} 重新连接`);
      return;
    }

    const seatIndex = this.players.findIndex(player => player === null);
    if (seatIndex === -1) {
      socket.emit('error', '房间已满');
      return;
    }
    this.players[seatIndex] = {
      id: socket.id,
      name,
      playerKey,
      socket,
      seatIndex,
      isReady: false,
      isHost: !this.players.some(seated => seated && seated.isHost)
    };
    socket.join(this.id);
    this.bindSocketListeners(socket);
    this.broadcastState();
  }

  private unbind(socket: Socket) {
    for (const eventName of this.roomEventNames) socket.removeAllListeners(eventName);
  }

  private bindSocketListeners(socket: Socket) {
    this.unbind(socket);
    socket.on('ready', () => {
      const idx = this.getSeat(socket);
      if (idx !== -1) this.toggleReady(idx);
    });
    socket.on('start', () => this.forceStart(socket));
    socket.on('chatMessage', (msg: unknown) => this.handleChat(socket, msg));
    socket.on('switchSeat', (targetSeat: number) => this.switchSeat(socket, targetSeat));
    socket.on('setGameMode', (mode: GameMode) => this.setGameMode(socket, mode));
    socket.on('forceEndGame', () => this.handleForceEnd(socket));
    socket.on('leaveRoom', () => this.leave(socket));
  }

  forceClose() {
    const sockets = this.players.flatMap(player => player?.socket ? [player.socket] : []);
    this.match?.forceEndMatch();
    this.match = null;
    this.io.to(this.id).emit('notice', 'RoomDeck 房间主强制结束了牌桌');
    this.io.to(this.id).emit('gameTerminated');
    for (const socket of sockets) {
      this.unbind(socket);
      socket.leave(this.id);
      socket.emit('leftRoom');
    }
    this.players = [null, null, null, null];
    this.broadcastState();
    this.onEmpty?.();
  }

  private handleForceEnd(socket: Socket) {
    if (!this.isHostSocket(socket)) {
      socket.emit('error', '只有房主可以强制结束游戏');
      return;
    }
    if (!this.match) {
      socket.emit('error', '当前没有正在进行的对局');
      return;
    }
    this.match.forceEndMatch();
    this.match = null;
    this.releaseBots();
    this.io.to(this.id).emit('notice', '房主强制结束了对局');
    this.io.to(this.id).emit('gameTerminated');
    this.broadcastState();
  }

  private setGameMode(socket: Socket, mode: GameMode) {
    if (!this.isHostSocket(socket)) {
      socket.emit('error', '只有房主可以切换游戏模式');
      return;
    }
    if (this.match && this.match.matchWinner === null) {
      socket.emit('error', '对局进行中无法切换模式');
      return;
    }
    if (mode !== GameMode.Normal && mode !== GameMode.Skill) {
      socket.emit('error', '请选择普通或技能模式');
      return;
    }
    this.gameMode = mode;
    this.io.to(this.id).emit('notice', `游戏模式已切换为: ${mode === GameMode.Skill ? '技能模式' : '普通模式'}`);
    this.broadcastState();
  }

  private handleChat(socket: Socket, msg: unknown) {
    const player = this.players.find(seated => seated && seated.socket === socket);
    if (!player) return;
    if (typeof msg !== 'string' || !msg.trim() || msg.trim().length > 200) {
      socket.emit('error', '聊天消息须为 1–200 个字符');
      return;
    }
    this.io.to(this.id).emit('chatMessage', {
      sender: player.name,
      text: msg.trim(),
      time: new Date().toLocaleTimeString(),
      seatIndex: player.seatIndex
    });
  }

  private switchSeat(socket: Socket, targetSeat: number) {
    if (this.match && this.match.matchWinner === null) return;
    if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat > 3) return;
    const currentIdx = this.players.findIndex(player => player && player.socket === socket);
    if (currentIdx === -1 || this.players[targetSeat] !== null) return;
    const player = this.players[currentIdx]!;
    player.seatIndex = targetSeat;
    this.players[targetSeat] = player;
    this.players[currentIdx] = null;
    this.broadcastState();
  }

  getSeat(socket: Socket): number {
    const player = this.players.find(seated => seated && seated.socket === socket);
    return player ? player.seatIndex : -1;
  }

  private isHostSocket(socket: Socket) {
    return !!this.players.find(seated => seated && seated.socket === socket)?.isHost;
  }

  private ensureHost() {
    if (this.players.some(player => player && player.isHost && !player.isDisconnected && !player.isBot)) return;
    this.players.forEach(player => { if (player) player.isHost = false; });
    const next = this.players.find(player => player && !player.isBot && !player.isDisconnected);
    if (next) next.isHost = true;
  }

  private inLiveMatch() {
    return !!(this.match && this.match.currentGame && this.match.matchWinner === null);
  }

  leave(socket: Socket) {
    const index = this.players.findIndex(player => player && player.socket === socket);
    if (index !== -1) this.detach(index, socket, true);
  }

  handleDisconnect(socket: Socket) {
    const index = this.players.findIndex(player => player && player.socket === socket);
    if (index !== -1) this.detach(index, socket, false);
  }

  /** 离开或断线。牌局中保留座位并托管，等待同名重连。 */
  private detach(index: number, socket: Socket, explicit: boolean) {
    const player = this.players[index]!;
    const playerName = player.name;
    this.unbind(socket);
    this.match?.currentGame?.detachPlayer(index, socket);
    player.socket = undefined;
    player.isReady = false;
    socket.leave(this.id);
    if (this.inLiveMatch()) {
      player.isDisconnected = true;
      this.match!.currentGame!.noteDisconnected(index);
      this.io.to(this.id).emit('notice', explicit
        ? `${playerName} 离开了，系统托管`
        : `${playerName} 断线，系统托管，等待重连`);
    } else {
      const wasHost = !!player.isHost;
      this.players[index] = null;
      if (wasHost) this.ensureHost();
      this.io.to(this.id).emit('notice', `${playerName} 离开了房间`);
    }
    this.broadcastState();
    if (this.isEmpty()) this.onEmpty?.();
    if (explicit) socket.emit('leftRoom');
  }

  private toggleReady(seatIndex: number) {
    const player = this.players[seatIndex];
    if (!player || player.isDisconnected || this.inLiveMatch()) return;
    player.isReady = !player.isReady;
    this.broadcastState();
    if (player.isReady) this.tryAutoStart();
  }

  private tryAutoStart() {
    const readyCount = this.players.filter(player => player && player.isReady && !player.isDisconnected).length;
    if (readyCount === 4 && !this.match) this.startGame();
  }

  private forceStart(socket: Socket) {
    if (!this.isHostSocket(socket)) {
      socket.emit('error', '只有房主可以开始游戏');
      return;
    }
    if (this.match && this.match.matchWinner === null) return;
    this.startGame();
  }

  startGame() {
    const gamePlayers = this.players.map((player, index): Player => player || {
      id: `bot-${index}`,
      name: `Bot ${index}`,
      seatIndex: index,
      isReady: true,
      isBot: true
    });
    this.players = gamePlayers;
    this.match = new Match(this.io, this.id, gamePlayers, this.gameMode);
    this.bindMatch();
    this.match.startMatch();
    this.broadcastState();
    this.io.to(this.id).emit('matchStarted');
  }

  bindMatch() {
    this.match!.onStateChange = () => this.onChange?.();
    this.match!.onMatchEnd = () => {
      this.match?.destroy();
      this.match = null;
      this.releaseBots();
    };
  }

  /** 整场结束后清掉 Bot 和没回来的人，房主仍是原来的玩家。 */
  private releaseBots() {
    this.players = this.players.map(player => !player || player.isBot || player.isDisconnected ? null : player);
    this.ensureHost();
    this.players.forEach(player => { if (player) player.isReady = false; });
    this.broadcastState();
    if (this.isEmpty()) this.onEmpty?.();
  }

  broadcastState() {
    this.onChange?.();
    const playerList = this.players.map(player => player ? {
      id: player.id,
      name: player.name,
      seatIndex: player.seatIndex,
      isReady: player.isReady,
      isBot: player.isBot,
      isDisconnected: player.isDisconnected,
      isHost: player.isHost
    } : null);
    this.io.to(this.id).emit('roomState', { roomId: this.id, players: playerList, gameMode: this.gameMode });
  }
}
