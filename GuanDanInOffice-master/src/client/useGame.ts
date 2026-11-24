import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { socket as defaultSocket } from './socket';
import { Card, GameMode, SkillCard, Hand, HistoryEntry, Rank } from '../shared/types';
import { browserStorage, launchFromUrl, NAME_KEY, parseSession, readStorage, roomFromUrl, RoomSession, SESSION_KEY, writeStorage } from './session';

export interface GameState {
  phase: string;
  level: number;
  currentTurn: number;
  hands: (Card[] | number)[];
  lastHand: { playerIndex: number; hand: Hand } | null;
  roundActions?: { [seat: number]: { type: 'play' | 'pass'; cards?: Card[]; hand?: Hand } };
  winners: number[];
  tributeState?: {
    pendingTributes: { from: number; to: number; card?: Card }[];
    pendingReturns: { from: number; to: number; card?: Card }[];
  };
  teamLevels?: { [key: number]: number };
  activeTeam?: number;
  gameMode?: GameMode;
  mySkillCards?: SkillCard[];
  skipNextTurn?: boolean[];
  newCardIds?: string[];
  history?: HistoryEntry[];
  currentRound?: number;
}

export interface RoomPlayer {
  id: string;
  name: string;
  seatIndex: number;
  isReady: boolean;
  isHost: boolean;
  isBot?: boolean;
  isDisconnected?: boolean;
}

export interface RoomState {
  roomId: string;
  players: (RoomPlayer | null)[];
  gameMode?: GameMode;
}

export interface RoomInfo {
  id: string;
  playerCount: number;
  maxPlayers: number;
  inGame: boolean;
  gameMode: GameMode;
  hostName: string;
}

export interface ChatMessage {
  sender: string;
  text: string;
  time: string;
  seatIndex: number;
}

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting';

function levelLabel(level: number): string {
  return level === Rank.Jack ? 'J' : level === Rank.Queen ? 'Q' : level === Rank.King ? 'K' : level === Rank.Ace ? 'A' : String(level);
}

export function useGame(socket: Socket = defaultSocket) {
  const [inRoom, setInRoom] = useState(false);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [mySeat, setMySeat] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [matchResult, setMatchResult] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'connected' : 'connecting');
  const [joining, setJoining] = useState(false);
  const [roomListLoading, setRoomListLoading] = useState(false);
  const [roomListLoaded, setRoomListLoaded] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [roomList, setRoomList] = useState<RoomInfo[]>([]);

  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const joinTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roomListTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentRoomId = useRef<string | null>(null);
  const savedSession = useRef<RoomSession | null>(null);
  const pendingJoin = useRef<RoomSession | null>(null);
  const roomListRequested = useRef(false);

  const showError = useCallback((message: string) => {
    setError(message);
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 6000);
  }, []);

  const resetRoom = useCallback(() => {
    setInRoom(false);
    setRoomState(null);
    setGameState(null);
    setMySeat(-1);
    setChatMessages([]);
    setMatchResult(null);
    currentRoomId.current = null;
  }, []);

  const armJoinTimeout = useCallback(() => {
    clearTimeout(joinTimer.current);
    joinTimer.current = setTimeout(() => {
      pendingJoin.current = null;
      setJoining(false);
      resetRoom();
      showError('进入房间超时，请检查连接后重试。');
    }, 8000);
  }, [resetRoom, showError]);

  const requestJoin = useCallback((session: RoomSession) => {
    if (!socket.connected || pendingJoin.current) return;
    pendingJoin.current = session;
    setJoining(true);
    setError(null);
    armJoinTimeout();
    socket.emit('joinRoom', session);
  }, [armJoinTimeout, socket]);

  useEffect(() => {
    const stored = parseSession(readStorage(browserStorage('sessionStorage'), SESSION_KEY));
    const inviteRoom = roomFromUrl(window.location.href);
    const launchToken = launchFromUrl(window.location.href);
    savedSession.current = launchToken
      ? { launchToken }
      : stored && (!inviteRoom || inviteRoom === ('roomId' in stored ? stored.roomId : null))
        ? stored
        : null;
    if (savedSession.current) {
      writeStorage(browserStorage('sessionStorage'), SESSION_KEY, JSON.stringify(savedSession.current));
    }

    const onConnect = () => {
      setConnection('connected');
      setGameState(null);
      if (savedSession.current) requestJoin(savedSession.current);
    };
    const onDisconnect = () => {
      setConnection('reconnecting');
      pendingJoin.current = null;
      setJoining(false);
      clearTimeout(joinTimer.current);
      roomListRequested.current = false;
      setRoomListLoading(false);
      clearTimeout(roomListTimer.current);
    };
    const onRoomState = (state: RoomState) => {
      const me = state.players.find(player => player?.id === socket.id);
      if (!me) return;
      if (currentRoomId.current !== state.roomId) {
        setGameState(null);
        setChatMessages([]);
        setMatchResult(null);
      }
      currentRoomId.current = state.roomId;
      const url = new URL(window.location.href);
      url.searchParams.set('room', state.roomId);
      url.searchParams.delete('launch');
      window.history.replaceState(null, '', url);
      if (!savedSession.current || !('launchToken' in savedSession.current)) {
        savedSession.current = { playerName: me.name, roomId: state.roomId };
      }
      writeStorage(browserStorage('sessionStorage'), SESSION_KEY, JSON.stringify(savedSession.current));
      writeStorage(browserStorage('localStorage'), NAME_KEY, me.name);
      pendingJoin.current = null;
      clearTimeout(joinTimer.current);
      setJoining(false);
      setError(null);
      setRoomState(state);
      setMySeat(me.seatIndex);
      setInRoom(true);
    };
    const onError = (message: string) => {
      if (pendingJoin.current) {
        pendingJoin.current = null;
        savedSession.current = null;
        writeStorage(browserStorage('sessionStorage'), SESSION_KEY, null);
        clearTimeout(joinTimer.current);
        setJoining(false);
        resetRoom();
      }
      showError(message);
    };
    const onNotice = (message: string) => {
      setNotice(message);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    };
    const onGameState = (state: GameState) => {
      if (currentRoomId.current) setGameState(state);
    };
    const onChatMessage = (message: ChatMessage) => {
      if (currentRoomId.current) setChatMessages(previous => [...previous.slice(-99), message]);
    };
    const onMatchOver = (data: { winningTeam: number; finalLevels: { [key: number]: number } }) => {
      if (!currentRoomId.current) return;
      setMatchResult(`对局结束，座位 ${data.winningTeam + 1} 和 ${data.winningTeam + 3} 获胜。打${levelLabel(data.finalLevels[0])} 对 打${levelLabel(data.finalLevels[1])}`);
      setGameState(null);
    };
    const onGameTerminated = () => setGameState(null);
    const onLeftRoom = () => {
      savedSession.current = null;
      pendingJoin.current = null;
      writeStorage(browserStorage('sessionStorage'), SESSION_KEY, null);
      clearTimeout(joinTimer.current);
      setJoining(false);
      resetRoom();
    };
    const onRoomList = (list: RoomInfo[]) => {
      setRoomList(list);
      setRoomListLoaded(true);
      setRoomListLoading(false);
      roomListRequested.current = false;
      clearTimeout(roomListTimer.current);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('roomState', onRoomState);
    socket.on('gameState', onGameState);
    socket.on('chatMessage', onChatMessage);
    socket.on('error', onError);
    socket.on('notice', onNotice);
    socket.on('matchOver', onMatchOver);
    socket.on('gameTerminated', onGameTerminated);
    socket.on('leftRoom', onLeftRoom);
    socket.on('roomList', onRoomList);

    if (pendingJoin.current) armJoinTimeout();
    else if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('roomState', onRoomState);
      socket.off('gameState', onGameState);
      socket.off('chatMessage', onChatMessage);
      socket.off('error', onError);
      socket.off('notice', onNotice);
      socket.off('matchOver', onMatchOver);
      socket.off('gameTerminated', onGameTerminated);
      socket.off('leftRoom', onLeftRoom);
      socket.off('roomList', onRoomList);
      [errorTimer, noticeTimer, joinTimer, roomListTimer].forEach(timer => clearTimeout(timer.current));
      roomListRequested.current = false;
    };
  }, [armJoinTimeout, requestJoin, resetRoom, showError, socket]);

  const emitInRoom = useCallback((event: string, payload?: unknown) => {
    if (!socket.connected || pendingJoin.current || !currentRoomId.current) return;
    socket.emit(event, payload);
  }, [socket]);

  const fetchRoomList = useCallback(() => {
    if (!socket.connected || roomListRequested.current) return;
    roomListRequested.current = true;
    setRoomListLoading(true);
    socket.emit('getRoomList');
    roomListTimer.current = setTimeout(() => {
      roomListRequested.current = false;
      setRoomListLoading(false);
    }, 5000);
  }, [socket]);

  const actions = useMemo(() => ({
    joinRoom: (playerName: string, roomId: string) => requestJoin({ playerName: playerName.trim(), roomId: roomId.trim() || 'default' }),
    setReady: () => emitInRoom('ready'),
    startGame: () => emitInRoom('start'),
    playHand: (cards: Card[], handType?: Hand) => emitInRoom('playHand', { cards, handType }),
    passTurn: () => emitInRoom('pass'),
    payTribute: (cards: Card[]) => emitInRoom('tribute', cards),
    returnTribute: (cards: Card[]) => emitInRoom('returnTribute', cards),
    sendChat: (message: string) => {
      const text = message.trim();
      if (!text || text.length > 200) {
        showError('聊天消息需要 1–200 个字。');
        return;
      }
      emitInRoom('chatMessage', text);
    },
    switchSeat: (seat: number) => emitInRoom('switchSeat', seat),
    setGameMode: (mode: GameMode) => emitInRoom('setGameMode', mode),
    useSkill: (skillId: string, targetSeat?: number) => emitInRoom('useSkill', { skillId, targetSeat }),
    forceEndGame: () => emitInRoom('forceEndGame'),
    leaveRoom: () => emitInRoom('leaveRoom'),
    fetchRoomList,
    retryConnection: () => socket.connect(),
    dismissMatchResult: () => setMatchResult(null),
    dismissError: () => setError(null),
  }), [emitInRoom, fetchRoomList, requestJoin, showError, socket]);

  return {
    inRoom,
    roomState,
    gameState,
    mySeat,
    error,
    notice,
    matchResult,
    chatMessages,
    roomList,
    roomListLoaded,
    roomListLoading,
    connection,
    joining,
    actions,
  };
}
