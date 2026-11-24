import { Server } from 'socket.io';
import { Game, GamePhase, GameSnapshot } from './game';
import { Player } from './room';
import { GameMode } from '../shared/types';

export interface MatchSnapshot {
  teamLevels: { [key: number]: number };
  activeTeam: number;
  consecutiveWins: { [key: number]: number };
  lastWinners: number[];
  roundNumber: number;
  currentGame: GameSnapshot | null;
}

/** Match represents a full game series (从2打到A). */
export class Match {
  currentGame: Game | null = null;
  teamLevels: { [key: number]: number } = { 0: 2, 1: 2 };
  activeTeam = 0;
  consecutiveWins: { [key: number]: number } = { 0: 0, 1: 0 };
  matchWinner: number | null = null;
  private lastWinners: number[] = [];
  roundNumber = 0;
  onMatchEnd?: () => void;
  onStateChange?: () => void;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recovered = false;
  private nextGameTimer: NodeJS.Timeout | null = null;
  private aborted = false;

  constructor(
    public io: Server,
    public roomId: string,
    public players: Player[],
    public gameMode: GameMode
  ) {}

  snapshot(): MatchSnapshot {
    return {
      teamLevels: this.teamLevels,
      activeTeam: this.activeTeam,
      consecutiveWins: this.consecutiveWins,
      lastWinners: this.lastWinners,
      roundNumber: this.roundNumber,
      currentGame: this.currentGame?.snapshot() ?? null
    };
  }

  restore(state: MatchSnapshot) {
    this.teamLevels = state.teamLevels;
    this.activeTeam = state.activeTeam;
    this.consecutiveWins = state.consecutiveWins;
    this.lastWinners = state.lastWinners;
    this.roundNumber = state.roundNumber;
    this.currentGame = new Game(this.io, this.roomId, this.players.map(p => ({ ...p })), this.gameMode);
    this.currentGame.restore(state.currentGame!);
    this.bindGame();
    this.recovered = true;
  }

  /** Keep recovered games frozen until someone returns, then allow reconnect grace. */
  resumeAfterRestart(delayMs = 15000): boolean {
    if (!this.recovered || this.recoveryTimer) return false;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.aborted) return;
      if (!this.players.some(player => !player.isBot && !player.isDisconnected && player.socket)) return;
      this.recovered = false;
      this.io.to(this.roomId).emit('notice', '重启恢复缓冲已结束，未重连的玩家由系统托管');
      if (this.currentGame?.currentPhase === GamePhase.Score) this.startNextGame();
      else this.currentGame?.resumeAfterRestart();
    }, delayMs);
    return true;
  }

  private bindGame() {
    this.currentGame!.onGameEnd = winners => this.handleGameEnd(winners);
    this.currentGame!.onStateChange = () => this.onStateChange?.();
  }

  startMatch() {
    console.log(`[Match ${this.roomId}] Starting new match. Mode: ${this.gameMode}`);
    this.teamLevels = { 0: 2, 1: 2 };
    this.activeTeam = 0;
    this.consecutiveWins = { 0: 0, 1: 0 };
    this.matchWinner = null;
    this.roundNumber = 0;
    this.startNextGame();
  }

  startNextGame() {
    if (this.nextGameTimer) clearTimeout(this.nextGameTimer);
    this.nextGameTimer = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recovered = false;
    if (this.aborted || this.matchWinner !== null) {
      console.log(`[Match ${this.roomId}] Not starting next game. aborted=${this.aborted}, winner=${this.matchWinner}`);
      return;
    }

    console.log(`[Match ${this.roomId}] Starting new game. Team levels: ${JSON.stringify(this.teamLevels)}, Active team: ${this.activeTeam}`);
    this.currentGame?.destroy();
    const gamePlayers = this.players.map(p => ({ ...p }));
    this.currentGame = new Game(this.io, this.roomId, gamePlayers, this.gameMode);
    this.roundNumber += 1;
    this.currentGame.currentRound = this.roundNumber;
    this.currentGame.teamLevels = { ...this.teamLevels };
    this.currentGame.activeTeam = this.activeTeam;
    this.currentGame.prevWinners = this.lastWinners || [];
    this.bindGame();
    this.currentGame.start();
  }

  handleGameEnd(winners: number[]) {
    if (winners.length !== 4) {
      console.error(`[Match ${this.roomId}] Invalid winners array:`, winners);
      return;
    }
    console.log(`[Match ${this.roomId}] Game ended. Winners order: ${winners}`);
    const { winningTeam, levelIncrease } = this.calculateLevelUp(winners);
    const oldLevel = this.teamLevels[winningTeam];
    this.teamLevels[winningTeam] = Math.min(14, oldLevel + levelIncrease);
    console.log(`[Match ${this.roomId}] Team ${winningTeam} level: ${oldLevel} -> ${this.teamLevels[winningTeam]} (+${levelIncrease})`);
    if (winningTeam !== this.activeTeam) {
      this.activeTeam = winningTeam;
      console.log(`[Match ${this.roomId}] Banker changed to Team ${this.activeTeam}`);
    }

    if (this.teamLevels[winningTeam] === 14) {
      this.consecutiveWins[winningTeam]++;
      this.consecutiveWins[1 - winningTeam] = 0;
      console.log(`[Match ${this.roomId}] Team ${winningTeam} at level A. Consecutive wins: ${this.consecutiveWins[winningTeam]}`);
      if (this.consecutiveWins[winningTeam] >= 2) {
        this.matchWinner = winningTeam;
        console.log(`[Match ${this.roomId}] MATCH WON by Team ${winningTeam}!`);
        this.broadcastMatchEnd(winningTeam);
        return;
      }
    } else {
      this.consecutiveWins = { 0: 0, 1: 0 };
    }

    this.lastWinners = winners;
    if (this.recovered) return;
    if (this.nextGameTimer) clearTimeout(this.nextGameTimer);
    this.nextGameTimer = setTimeout(() => {
      this.nextGameTimer = null;
      if (this.aborted) return;
      this.startNextGame();
    }, 3000);
  }

  calculateLevelUp(winners: number[]): { winningTeam: number; levelIncrease: number } {
    const [p1, p2, p3] = winners;
    const isSameTeam = (a: number, b: number) => a % 2 === b % 2;
    const winningTeam = p1 % 2;
    const levelIncrease = isSameTeam(p1, p2) ? 3 : isSameTeam(p1, p3) ? 2 : 1;
    return { winningTeam, levelIncrease };
  }

  broadcastMatchEnd(winningTeam: number) {
    const teamPlayers = this.players.filter(p => p.seatIndex % 2 === winningTeam);
    this.onMatchEnd?.();
    this.io.to(this.roomId).emit('matchOver', {
      winningTeam,
      winners: teamPlayers.map(p => ({ name: p.name, seatIndex: p.seatIndex })),
      finalLevels: this.teamLevels
    });
  }

  getMatchState() {
    return {
      teamLevels: this.teamLevels,
      activeTeam: this.activeTeam,
      consecutiveWins: this.consecutiveWins,
      matchWinner: this.matchWinner,
      inProgress: this.currentGame !== null && this.matchWinner === null
    };
  }

  destroy() {
    this.aborted = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.nextGameTimer) {
      clearTimeout(this.nextGameTimer);
      this.nextGameTimer = null;
    }
    this.currentGame?.destroy();
  }

  forceEndMatch() {
    console.log(`[Match ${this.roomId}] Force ending match`);
    this.destroy();
    this.currentGame = null;
    this.matchWinner = null;
    this.consecutiveWins = { 0: 0, 1: 0 };
  }
}
