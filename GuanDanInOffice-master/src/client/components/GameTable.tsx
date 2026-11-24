import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Card as CardType, GameMode, Hand, HandType, Rank, SkillCard, SkillCardType, Suit } from '../../shared/types';
import { Bot } from '../../shared/bot';
import { arrangeHand, CardGroup } from '../../shared/arrange';
import { getAllPossibleHandTypes, getHandDescription, sortCards } from '../../shared/rules';
import type { ChatMessage, GameState, RoomPlayer, RoomState } from '../useGame';
import { Card } from './Card';
import { SkillCardButton } from './SkillCardButton';
import { TargetSelectModal } from './TargetSelectModal';
import { GameHistory } from './GameHistory';
import { GameDialog } from './gameDialog';
import { evaluateSelection, getTributeEligibleIds } from './gameSelection';
import './gameTable.css';

interface Props {
  interactionDisabled?: boolean;
  gameState: GameState | null;
  roomState: RoomState;
  mySeat: number;
  onPlay: (cards: CardType[], handType?: Hand) => void;
  onPass: () => void;
  onReady?: () => void;
  onStart?: () => void;
  onTribute?: (cards: CardType[]) => void;
  onReturnTribute?: (cards: CardType[]) => void;
  chatMessages: ChatMessage[];
  onSendChat: (message: string) => void;
  onSwitchSeat?: (seat: number) => void;
  onSetGameMode?: (mode: GameMode) => void;
  onUseSkill?: (skillId: string, targetSeat?: number) => void;
  onForceEndGame?: () => void;
  onLeave?: () => void;
}

const EMPTY_HAND: CardType[] = [];
const CHAT_LIMIT = 200;
const quickEmojis = ['😀', '😂', '😎', '🥳', '😭', '🤔', '👍', '🔥', '🎉', '🤝', '💪', '🙏'];
const stackSuits = [Suit.Joker, Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds];
const winnerLabels = ['头游', '二游', '三游', '末游'];

function levelLabel(level: number): string {
  return level === Rank.Jack ? 'J' : level === Rank.Queen ? 'Q' : level === Rank.King ? 'K' : level === Rank.Ace ? 'A' : String(level);
}

function handCount(gameState: GameState, seat: number): number {
  const hand = gameState?.hands[seat];
  return Array.isArray(hand) ? hand.length : typeof hand === 'number' ? hand : 0;
}

function PlayerSeat({ player, seat, mySeat, position, gameState, bubble }: {
  player: RoomPlayer | null | undefined;
  seat: number;
  mySeat: number;
  position: 'top' | 'left' | 'right';
  gameState: GameState;
  bubble?: string;
}) {
  const teammate = seat % 2 === mySeat % 2;
  const count = handCount(gameState, seat);
  const action = gameState.roundActions?.[seat];
  const winnerIndex = gameState.winners.indexOf(seat);
  const active = gameState.phase === 'Playing' && gameState.currentTurn === seat;
  return (
    <section className={`game-seat game-seat--${position}${teammate ? ' is-teammate' : ''}${active ? ' is-active' : ''}`} aria-label={`${player?.name || '玩家'}，${teammate ? '队友' : '对手'}，剩余 ${count} 张`}>
      <div className="game-seat__identity">
        <span className="game-seat__avatar" aria-hidden="true">{player?.name?.slice(0, 1).toUpperCase() || '?'}</span>
        <div className="game-seat__details"><strong title={player?.name}>{player?.name || '等待中'}</strong><span>{teammate ? '队友' : '对手'}{player?.isHost ? ' · 房主' : ''}{player?.isBot ? ' · AI' : ''}</span></div>
      </div>
      <div className="game-seat__count"><strong className={count <= 5 ? 'is-low' : ''}>{count}</strong><span>张牌</span>{winnerIndex >= 0 && <span className="game-badge game-badge--violet">{winnerLabels[winnerIndex]}</span>}</div>
      <div className="game-seat__activity">{player?.isDisconnected ? '离线 · 托管中' : active ? '思考中…' : action?.type === 'pass' ? '已过牌' : action?.hand ? getHandDescription(action.hand, gameState.level) : winnerIndex >= 0 ? '已出完' : '等待出牌'}</div>
      {bubble && <div className="game-seat__bubble" title={bubble}>{bubble}</div>}
    </section>
  );
}

export const GameTable: React.FC<Props> = ({
  interactionDisabled = false,
  gameState,
  roomState,
  mySeat,
  onPlay,
  onPass,
  onTribute,
  onReturnTribute,
  chatMessages,
  onSendChat,
  onUseSkill,
  onForceEndGame,
  onLeave,
}) => {
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'arranged' | 'rank' | 'stacked'>('arranged');
  const [feedback, setFeedback] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pendingSkill, setPendingSkill] = useState<SkillCard | null>(null);
  const [possibleHands, setPossibleHands] = useState<Hand[]>([]);
  const [highlightedCardIds, setHighlightedCardIds] = useState<Set<string>>(new Set());
  const [chatBubbles, setChatBubbles] = useState<Record<number, string>>({});
  const bubbleTimers = useRef<Record<number, number>>({});
  const chatList = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatButton = useRef<HTMLButtonElement>(null);
  const followChat = useRef(true);
  const handDialogId = useId();
  const selectionStatusId = useId();
  const chatPanelId = useId();

  const level = gameState?.level ?? 2;
  const myHand = gameState && Array.isArray(gameState.hands[mySeat]) ? gameState.hands[mySeat] as CardType[] : EMPTY_HAND;
  const groups = useMemo(() => arrangeHand(myHand, level), [myHand, level]);
  const orderedHand = viewMode === 'rank' ? sortCards(myHand, level) : groups.flatMap(group => group.cards);
  const selectedIds = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);
  const selectedCards = useMemo(() => myHand.filter(card => selectedIds.has(card.id)), [myHand, selectedIds]);
  const target = gameState?.lastHand && gameState.lastHand.playerIndex !== mySeat ? gameState.lastHand.hand : null;
  const selection = useMemo(() => evaluateSelection(selectedCards, level, target), [selectedCards, level, target]);
  const isMyTurn = !interactionDisabled && gameState?.phase === 'Playing' && gameState.currentTurn === mySeat && myHand.length > 0;
  const isTributePhase = gameState?.phase === 'Tribute' || gameState?.phase === 'ReturnTribute';
  const amIPaying = !interactionDisabled && !!(isTributePhase && (gameState.phase === 'Tribute' ? gameState.tributeState?.pendingTributes : gameState.tributeState?.pendingReturns)?.some(item => item.from === mySeat && !item.card));
  const tributeEligibleIds = useMemo(() => amIPaying ? getTributeEligibleIds(myHand, level, gameState?.phase || '') : new Set<string>(), [amIPaying, myHand, level, gameState?.phase]);
  const canSubmitTribute = selectedCards.length === 1 && tributeEligibleIds.has(selectedCards[0].id);
  const straightFlushIds = useMemo(() => new Set(groups.filter(group => group.type === HandType.StraightFlush).flatMap(group => group.cards.map(card => card.id))), [groups]);
  const handSignature = myHand.map(card => card.id).join('|');
  const newCardSignature = gameState?.newCardIds?.join('|') || '';

  useEffect(() => {
    setSelectedCardIds(previous => {
      const retained = previous.filter(id => myHand.some(card => card.id === id));
      return retained.length === previous.length ? previous : retained;
    });
  }, [myHand]);
  useEffect(() => {
    if (interactionDisabled) {
      setShowHistory(false);
      setPendingSkill(null);
      setPossibleHands([]);
    }
  }, [interactionDisabled]);
  useEffect(() => {
    setPossibleHands([]);
    setFeedback('');
  }, [gameState?.currentTurn, gameState?.phase, gameState?.currentRound, handSignature]);
  useEffect(() => {
    if (pendingSkill && (!isMyTurn || !gameState?.mySkillCards?.some(skill => skill.id === pendingSkill.id))) setPendingSkill(null);
  }, [isMyTurn, gameState?.mySkillCards, pendingSkill]);
  useEffect(() => {
    if (!newCardSignature) {
      setHighlightedCardIds(new Set());
      return;
    }
    setHighlightedCardIds(new Set(newCardSignature.split('|')));
    const timer = window.setTimeout(() => setHighlightedCardIds(new Set()), 3000);
    return () => window.clearTimeout(timer);
  }, [newCardSignature]);
  useEffect(() => {
    const latest = chatMessages[chatMessages.length - 1];
    if (!latest || latest.seatIndex === undefined) return;
    setChatBubbles(previous => ({ ...previous, [latest.seatIndex]: latest.text }));
    window.clearTimeout(bubbleTimers.current[latest.seatIndex]);
    bubbleTimers.current[latest.seatIndex] = window.setTimeout(() => {
      setChatBubbles(previous => {
        const updated = { ...previous };
        delete updated[latest.seatIndex];
        return updated;
      });
    }, 5000);
  }, [chatMessages]);
  useEffect(() => () => Object.values(bubbleTimers.current).forEach(timer => window.clearTimeout(timer)), []);
  useEffect(() => {
    const list = chatList.current;
    if (showChat && list && followChat.current) list.scrollTop = list.scrollHeight;
  }, [chatMessages, showChat]);
  useEffect(() => {
    if (showChat) chatInputRef.current?.focus({ preventScroll: true });
  }, [showChat]);

  const toggleSelect = (id: string) => {
    setFeedback('');
    setSelectedCardIds(previous => previous.includes(id) ? previous.filter(cardId => cardId !== id) : [...previous, id]);
  };
  const toggleGroup = (group: CardGroup) => {
    setFeedback('');
    const ids = group.cards.map(card => card.id);
    setSelectedCardIds(previous => ids.every(id => previous.includes(id)) ? previous.filter(id => !ids.includes(id)) : [...new Set([...previous, ...ids])]);
  };
  const clearSelection = () => {
    setSelectedCardIds([]);
    setFeedback('');
  };
  const handlePlay = () => {
    if (!isMyTurn || !selection.canPlay) return;
    const possibilities = selectedCards.some(card => card.isWild) ? getAllPossibleHandTypes(selectedCards, level) : [];
    if (possibilities.length > 1) {
      setPossibleHands(possibilities);
      return;
    }
    onPlay(selectedCards, selection.hand || undefined);
  };
  const handleHint = () => {
    if (!isMyTurn) return;
    const move = new Bot(orderedHand, level).decideMove(target);
    if (move && evaluateSelection(move, level, target).canPlay) {
      setSelectedCardIds(move.map(card => card.id));
      setFeedback('已选好建议出牌，你可以调整后再出。');
    } else {
      setFeedback(target ? '暂未找到可出的组合。可以自行选牌，或选择「过」。' : '暂未找到建议组合，请自行选择手牌。');
    }
  };
  const handleTribute = () => {
    if (!amIPaying || !canSubmitTribute) return;
    if (gameState?.phase === 'Tribute') onTribute?.(selectedCards);
    else onReturnTribute?.(selectedCards);
  };
  const handleSkill = (skill: SkillCard) => {
    if (!isMyTurn || !onUseSkill) return;
    if ([SkillCardType.Steal, SkillCardType.Discard, SkillCardType.Skip].includes(skill.type)) setPendingSkill(skill);
    else onUseSkill(skill.id);
  };
  const closeChat = () => {
    setShowChat(false);
    setShowEmojiPicker(false);
    chatButton.current?.focus({ preventScroll: true });
  };
  const submitChat = (event: React.FormEvent) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    if (text.length > CHAT_LIMIT) {
      setChatError('消息最多 200 个字符，请缩短后再发送。');
      return;
    }
    onSendChat(text);
    setChatInput('');
    setChatError('');
    followChat.current = true;
  };

  if (!gameState) return null;
  const myTeam = mySeat >= 0 ? mySeat % 2 : 0;
  const me = roomState.players.find(player => player?.seatIndex === mySeat);
  const currentPlayer = roomState.players.find(player => player?.seatIndex === gameState.currentTurn);
  const lastPlayer = roomState.players.find(player => player?.seatIndex === gameState.lastHand?.playerIndex);
  const turnStatus = gameState.phase === 'Score'
    ? '本局结束'
    : amIPaying
      ? gameState.phase === 'Tribute' ? '请进贡最大牌' : '请选择还贡牌'
      : isTributePhase
        ? '等待其他玩家进贡 / 还贡'
        : myHand.length === 0
          ? '你已出完，看看队友的表现'
          : isMyTurn
            ? '轮到你了'
            : `等待 ${currentPlayer?.name || '其他玩家'} 出牌`;
  const tributeGuidance = gameState.phase === 'Tribute'
    ? '选择一张黄框标出的最大牌'
    : myHand.some(card => card.rank <= Rank.Ten && card.rank !== level)
      ? '还贡 10 及以下，不能是级牌或王；黄框为可选牌'
      : '没有普通可还牌，请选择黄框标出的最小牌';
  const selectionMessage = amIPaying
    ? selectedCards.length === 0 ? tributeGuidance : canSubmitTribute ? '这张牌可以提交' : '请选择且只选择一张黄框牌'
    : isTributePhase
      ? '等待其他玩家提交进贡 / 还贡'
      : selection.canPlay && !isMyTurn
        ? `${getHandDescription(selection.hand!, level)} · 牌型有效，等待你的回合`
        : selection.message;
  const renderCard = (card: CardType, small = false) => <Card key={card.id} card={card} selected={selectedIds.has(card.id)} onClick={() => toggleSelect(card.id)} small={small} isHighlighted={highlightedCardIds.has(card.id)} hint={tributeEligibleIds.has(card.id)} />;

  return (
    <div className="game-screen">
      <header className="game-header">
        <div className="game-header__identity"><span className="game-eyebrow">GUANDAN / 房间 {roomState.roomId}</span><div className="game-header__title"><h1>当前 打{levelLabel(level)}</h1><span className="game-badge">第 {gameState.currentRound || 1} 局</span>{gameState.gameMode === GameMode.Skill && <span className="game-badge game-badge--violet">技能局</span>}</div></div>
        {gameState.teamLevels && <div className="game-scoreline"><span>我方 <strong>打{levelLabel(gameState.teamLevels[myTeam])}</strong>{gameState.activeTeam === myTeam && <i>庄</i>}</span><span>对方 <strong>打{levelLabel(gameState.teamLevels[1 - myTeam])}</strong>{gameState.activeTeam === 1 - myTeam && <i>庄</i>}</span></div>}
        <nav className="game-header__actions" aria-label="牌桌工具">
          <button ref={chatButton} type="button" className={`game-button ${showChat ? 'is-on' : ''}`} aria-expanded={showChat} aria-controls={chatPanelId} onClick={() => showChat ? closeChat() : setShowChat(true)}>聊天</button>
          <button type="button" className="game-button" onClick={() => setShowHistory(true)}>历史记录</button>
          {onLeave && <button type="button" className="game-button" onClick={onLeave}>离开房间</button>}
          {me?.isHost && onForceEndGame && <button type="button" className="game-button game-button--quiet-danger" onClick={() => { if (window.confirm('确定强制结束整场对局吗？当前进度将丢失，所有玩家返回准备房间。')) onForceEndGame(); }}>结束对局</button>}
        </nav>
      </header>
      <div className={`game-workspace${showChat ? ' has-chat' : ''}`}>
        <main className="game-board" aria-label="对局牌桌">
          {([{ offset: 2, position: 'top' }, { offset: 3, position: 'left' }, { offset: 1, position: 'right' }] as const).map(({ offset, position }) => {
            const seat = (mySeat + offset) % 4;
            return <PlayerSeat key={seat} player={roomState.players.find(player => player?.seatIndex === seat)} seat={seat} mySeat={mySeat} position={position} gameState={gameState} bubble={chatBubbles[seat]} />;
          })}
          <section className="game-center" aria-label="桌面出牌">
            {gameState.lastHand ? <><p className="game-eyebrow">{lastPlayer?.name || '玩家'} 出牌</p><div className="game-center__cards">{gameState.lastHand.hand.cards.map(card => <Card key={card.id} card={card} small />)}</div><span className="game-badge game-badge--teal">{getHandDescription(gameState.lastHand.hand, level)}</span></> : <div className="game-center__empty"><span aria-hidden="true">♠</span><p>{isTributePhase ? '进贡 / 还贡阶段' : '新的出牌轮次'}</p><small>{isTributePhase ? '黄框标出了可提交的牌' : isMyTurn ? '你可以自由出牌' : '等待首家出牌'}</small></div>}
          </section>
          <div className="game-board__caption">红心{levelLabel(level)}是万能牌 · 座位相对的玩家为队友</div>
        </main>
        {showChat && <aside className="game-chat" id={chatPanelId} aria-label="房间聊天" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeChat(); } }}>
          <div className="game-chat__header"><strong>房间聊天</strong><button type="button" className="game-button" onClick={closeChat} aria-label="关闭聊天">×</button></div>
          <div ref={chatList} className="game-chat__messages" role="log" aria-label="聊天消息" onScroll={event => {
            const list = event.currentTarget;
            followChat.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
          }}>
            {chatMessages.length === 0 && <p className="game-muted">打个招呼吧。消息仅在当前房间可见。</p>}
            {chatMessages.map((message, index) => <div className="game-chat__message" key={`${message.time}-${index}`}><div><strong>{message.sender}</strong><time>{message.time}</time></div><p>{message.text}</p></div>)}
          </div>
          {showEmojiPicker && <div className="game-chat__emoji">{quickEmojis.map(emoji => <button type="button" key={emoji} aria-label={`添加表情 ${emoji}`} disabled={chatInput.length + emoji.length > CHAT_LIMIT} onClick={() => { setChatInput(previous => previous.length + emoji.length <= CHAT_LIMIT ? previous + emoji : previous); setShowEmojiPicker(false); chatInputRef.current?.focus(); }}>{emoji}</button>)}</div>}
          <form className="game-chat__form" onSubmit={submitChat}>
            <button type="button" className="game-button" aria-label="选择表情" aria-expanded={showEmojiPicker} onClick={() => setShowEmojiPicker(previous => !previous)}>☺</button>
            <input ref={chatInputRef} aria-label="聊天消息" placeholder="输入消息…" maxLength={CHAT_LIMIT} value={chatInput} onChange={event => { setChatInput(event.target.value); setChatError(''); }} />
            <button type="submit" className="game-button game-button--primary" disabled={!chatInput.trim() || chatInput.trim().length > CHAT_LIMIT}>发送</button>
          </form>
          <div className="game-chat__limit"><span role="alert">{chatError}</span><span>{chatInput.length} / {CHAT_LIMIT}</span></div>
        </aside>}
      </div>
      <section className="game-handdock" aria-label="我的手牌与操作">
        <div className="game-turnbar"><div className={`game-turnbar__status${isMyTurn || amIPaying ? ' is-active' : ''}`} role="status"><span className="game-status-dot" /><strong>{turnStatus}</strong>{isMyTurn && <small>{target ? '跟牌' : '自由出牌'}</small>}</div><span className="game-muted game-me">{me?.name} · <strong>{myHand.length}</strong> 张</span></div>
        <div className="game-actionbar">
          <div className="game-selection" id={selectionStatusId} role="status"><span className="game-selection__count">已选 <strong>{selectedCards.length}</strong> 张</span><span className={selectedCards.length > 0 && (amIPaying ? !canSubmitTribute : !selection.canPlay) ? 'game-warning' : 'game-muted'}>{selectionMessage}</span></div>
          <div className="game-actionbar__buttons">
            <button type="button" className="game-button" onClick={clearSelection} disabled={!selectedCards.length}>清空选择</button>
            {amIPaying ? <button type="button" className="game-button game-button--primary" aria-describedby={selectionStatusId} onClick={handleTribute} disabled={!canSubmitTribute}>{gameState.phase === 'Tribute' ? '确认进贡' : '确认还贡'}</button> : <>
              <button type="button" className="game-button game-button--hint" onClick={handleHint} disabled={!isMyTurn}>提示</button>
              <button type="button" className="game-button game-button--primary" onClick={handlePlay} disabled={!isMyTurn || !selection.canPlay} aria-describedby={selectionStatusId}>出牌{selectedCards.length > 0 ? ` (${selectedCards.length})` : ''}</button>
              <button type="button" className="game-button" onClick={() => { if (isMyTurn && target) onPass(); }} disabled={!isMyTurn || !target} title={isMyTurn && !target ? '自由出牌时不能过牌' : undefined}>过</button>
            </>}
          </div>
        </div>
        {feedback && <p className="game-feedback" role="status">{feedback}</p>}
        {gameState.gameMode === GameMode.Skill && !!gameState.mySkillCards?.length && <div className="game-skills"><span className="game-eyebrow">技能 / 用后仍可出牌</span><div>{gameState.mySkillCards.map(skill => <SkillCardButton key={skill.id} skill={skill} onClick={() => handleSkill(skill)} disabled={!isMyTurn || !onUseSkill} />)}</div></div>}
        {myHand.length > 0 ? <>
          <div className="game-handtools"><div className="game-segmented" role="group" aria-label="手牌视图">{([['arranged', '理牌'], ['rank', '点数'], ['stacked', '同花顺']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)}>{label}</button>)}</div><span className="game-muted">{viewMode === 'arranged' ? '点组名选整组 · 左右滚动查看全部手牌' : viewMode === 'stacked' ? '同点数分列 · 金色标记同花顺' : '按点数排列 · 左右滚动查看全部手牌'}</span></div>
          <div className="game-handscroll" aria-label="手牌，可左右滚动" tabIndex={0}>
            {viewMode === 'arranged' ? <div className="game-handgroups">{groups.map(group => <div className="game-handgroup" key={group.id}><button className="game-group-label" type="button" aria-pressed={group.cards.every(card => selectedIds.has(card.id))} onClick={() => toggleGroup(group)} title="选中或取消整组">{group.label}</button><div className="game-cardfan">{group.cards.map(card => renderCard(card))}</div></div>)}</div>
              : viewMode === 'rank' ? <div className="game-rankhand game-cardfan">{orderedHand.map(card => renderCard(card))}</div>
                : <div className="game-stackedhand">{[Rank.BigJoker, Rank.SmallJoker, ...Array.from({ length: 13 }, (_, index) => Rank.Ace - index)].filter(rank => myHand.some(card => card.rank === rank)).map(rank => <div className="game-stackcolumn" key={rank}>{stackSuits.map(suit => <div className="game-stackslot" key={suit}>{myHand.filter(card => card.rank === rank && card.suit === suit).map(card => <div className={straightFlushIds.has(card.id) ? 'game-straight-card' : ''} key={card.id}>{renderCard(card, true)}</div>)}</div>)}</div>)}</div>}
          </div>
          <div className="game-handfooter"><span>Tab 切换卡牌 · 空格 / Enter 选牌</span>{chatBubbles[mySeat] && <span className="game-my-bubble">我：{chatBubbles[mySeat]}</span>}</div>
        </> : <div className="game-emptyhand">本局手牌已出完，继续为队友加油。</div>}
      </section>
      {gameState.phase === 'Score' && <section className="game-score-overlay" role="status" aria-label="本局结算"><div><span className="game-eyebrow">ROUND COMPLETE</span><h2>本局结束</h2><ol>{gameState.winners.map((seat, index) => <li key={seat}><span>{winnerLabels[index]}</span><strong>{roomState.players.find(player => player?.seatIndex === seat)?.name || `座位 ${seat + 1}`}</strong></li>)}</ol>{gameState.teamLevels && <p>我方 打{levelLabel(gameState.teamLevels[myTeam])} · 对方 打{levelLabel(gameState.teamLevels[1 - myTeam])}</p>}<p className="game-muted">即将自动开始下一局…</p></div></section>}
      <GameDialog open={possibleHands.length > 0 && isMyTurn} labelId={handDialogId} onClose={() => setPossibleHands([])}>
        <div className="game-dialog__header"><h2 id={handDialogId}>选择牌型</h2></div>
        <div className="game-dialog__body game-targets">{possibleHands.map((hand, index) => <button type="button" className="game-button" key={index} onClick={() => { if (isMyTurn && selection.canPlay) onPlay(selectedCards, hand); setPossibleHands([]); }}>{getHandDescription(hand, level)}</button>)}</div>
        <div className="game-dialog__footer"><button type="button" className="game-button" onClick={() => setPossibleHands([])}>取消</button></div>
      </GameDialog>
      {pendingSkill && isMyTurn && <TargetSelectModal skillType={pendingSkill.type} players={roomState.players.filter((player): player is RoomPlayer => player !== null).map(player => ({ ...player, handCount: handCount(gameState, player.seatIndex) }))} mySeat={mySeat} onSelect={seat => {
        if (isMyTurn && handCount(gameState, seat) > 0 && gameState.mySkillCards?.some(skill => skill.id === pendingSkill.id)) onUseSkill?.(pendingSkill.id, seat);
        setPendingSkill(null);
      }} onCancel={() => setPendingSkill(null)} />}
      <GameHistory history={gameState.history || []} currentRound={gameState.currentRound || 1} isOpen={showHistory && !interactionDisabled} onClose={() => setShowHistory(false)} />
    </div>
  );
};
