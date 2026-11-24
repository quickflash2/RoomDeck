export const COLORS = ['red', 'yellow', 'blue', 'green'];
export const COLOR_NAMES = {
  red: '红色',
  yellow: '黄色',
  blue: '蓝色',
  green: '绿色',
};

export function createDeck() {
  let nextId = 0;
  const deck = [];
  const add = (color, type, value = null) => {
    deck.push({ id: nextId++, color, type, value });
  };

  for (const color of COLORS) {
    add(color, 'number', 0);
    for (let value = 1; value <= 9; value += 1) {
      add(color, 'number', value);
      add(color, 'number', value);
    }
    for (const type of ['skip', 'drawTwo', 'reverse']) {
      add(color, type);
      add(color, type);
    }
  }

  for (let index = 0; index < 4; index += 1) add('wild', 'wild');
  for (let index = 0; index < 4; index += 1) add('wild', 'wildDrawFour');
  return deck;
}

export function shuffle(cards, random = Math.random) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export class UnoGame {
  constructor({ playerCount = 4, playerName = '你', random = Math.random } = {}) {
    if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 8) {
      throw new Error('游戏人数必须为 2 到 8 人');
    }

    this.random = random;
    this.players = Array.from({ length: playerCount }, (_, index) => ({
      name: index === 0 ? playerName.trim() || '你' : `AI ${index}`,
      hand: [],
      unoDeclared: false,
    }));
    this.discardPile = [];
    this.deck = shuffle(createDeck(), random);
    this.currentPlayer = 0;
    this.currentColor = null;
    this.direction = 1;
    this.phase = 'turn';
    this.drawnCardId = null;
    this.pendingPlay = null;
    this.winner = null;
    this.turn = 1;
    this.log = [];

    for (let round = 0; round < 7; round += 1) {
      for (const player of this.players) player.hand.push(this.takeCard());
    }

    const firstCardIndex = this.deck.findIndex((card) => card.type === 'number');
    const [firstCard] = this.deck.splice(firstCardIndex, 1);
    this.discardPile.push(firstCard);
    this.currentColor = firstCard.color;
    this.addLog(`游戏开始，首牌为 ${firstCard.color} ${firstCard.value}`);
  }

  get topCard() {
    return this.discardPile[this.discardPile.length - 1];
  }

  get currentPlayerData() {
    return this.players[this.currentPlayer];
  }

  addLog(message) {
    this.log.push(message);
    if (this.log.length > 40) this.log.shift();
  }

  takeCard() {
    if (this.deck.length === 0) {
      const top = this.discardPile.pop();
      this.deck = shuffle(this.discardPile, this.random);
      this.discardPile = top ? [top] : [];
      if (this.deck.length > 0) this.addLog('牌堆已重新洗牌');
    }
    return this.deck.pop() ?? null;
  }

  drawCards(playerIndex, count) {
    const cards = [];
    for (let index = 0; index < count; index += 1) {
      const card = this.takeCard();
      if (card) {
        this.players[playerIndex].hand.push(card);
        cards.push(card);
      }
    }
    return cards;
  }

  advance(steps = 1) {
    const count = this.players.length;
    return (this.currentPlayer + this.direction * steps + count * steps) % count;
  }

  canPlayCard(card, playerIndex = this.currentPlayer) {
    if (!card || !this.topCard) return false;
    if (card.type === 'wild') return true;
    if (card.type === 'wildDrawFour') {
      return !this.players[playerIndex].hand.some((item) => item.color === this.currentColor);
    }
    if (card.color === this.currentColor) return true;
    if (card.type === 'number' && this.topCard.type === 'number') {
      return card.value === this.topCard.value;
    }
    return card.type === this.topCard.type && ['skip', 'drawTwo', 'reverse'].includes(card.type);
  }

  getPlayableCards(playerIndex = this.currentPlayer) {
    if (playerIndex !== this.currentPlayer || !['turn', 'drawn'].includes(this.phase)) return [];
    const hand = this.players[playerIndex].hand;
    if (this.phase === 'drawn') {
      return hand.filter((card) => card.id === this.drawnCardId && this.canPlayCard(card, playerIndex));
    }
    return hand.filter((card) => this.canPlayCard(card, playerIndex));
  }

  declareUno() {
    if (this.phase !== 'turn' || this.currentPlayerData.hand.length !== 2) {
      throw new Error('剩两张牌且轮到你的回合时才能宣告 UNO');
    }
    this.currentPlayerData.unoDeclared = true;
    this.addLog(`${this.currentPlayerData.name} 宣告 UNO！`);
  }

  drawCard() {
    if (this.phase !== 'turn') throw new Error('当前不能抽牌');
    const [card] = this.drawCards(this.currentPlayer, 1);
    if (!card) throw new Error('没有可抽取的卡牌');
    this.phase = 'drawn';
    this.drawnCardId = card.id;
    this.currentPlayerData.unoDeclared = false;
    this.addLog(`${this.currentPlayerData.name} 抽了一张牌`);
    return card;
  }

  passTurn() {
    if (this.phase !== 'drawn') throw new Error('抽牌后才能结束回合');
    this.addLog(`${this.currentPlayerData.name} 结束了回合`);
    this.drawnCardId = null;
    this.currentPlayer = this.advance();
    this.phase = 'turn';
    this.turn += 1;
  }

  playCard(cardId, { color = null, uno = false } = {}) {
    const playable = this.getPlayableCards();
    if (!playable.some((card) => card.id === cardId)) throw new Error('这张牌现在不能出');
    const player = this.currentPlayerData;
    const card = player.hand.find((item) => item.id === cardId);
    const wantsUno = uno || player.unoDeclared;

    if (['wild', 'wildDrawFour'].includes(card.type) && !color) {
      this.pendingPlay = { cardId, uno: wantsUno, resumePhase: this.phase };
      this.phase = 'color';
      return { needsColor: true };
    }
    if (['wild', 'wildDrawFour'].includes(card.type) && !COLORS.includes(color)) {
      throw new Error('万能牌必须选择有效颜色');
    }

    player.hand.splice(player.hand.indexOf(card), 1);
    player.unoDeclared = false;
    this.discardPile.push(card);
    this.currentColor = card.color === 'wild' ? color : card.color;
    this.addLog(`${player.name} 打出了 ${card.type}${card.value ?? ''}`);

    if (player.hand.length === 1 && !wantsUno) {
      this.drawCards(this.currentPlayer, 2);
      this.addLog(`${player.name} 未宣告 UNO，罚抽两张牌`);
    }

    if (player.hand.length === 0) {
      this.winner = this.currentPlayer;
      this.phase = 'over';
      this.drawnCardId = null;
      this.pendingPlay = null;
      this.addLog(`${player.name} 赢得了本局游戏！`);
      return { winner: this.winner };
    }

    let steps = 1;
    const nextPlayer = this.advance();
    if (card.type === 'skip') {
      steps = 2;
      this.addLog(`${this.players[nextPlayer].name} 被跳过`);
    } else if (card.type === 'reverse') {
      this.direction *= -1;
      steps = this.players.length === 2 ? 2 : 1;
      this.addLog('出牌方向已反转');
    } else if (card.type === 'drawTwo' || card.type === 'wildDrawFour') {
      const count = card.type === 'drawTwo' ? 2 : 4;
      this.drawCards(nextPlayer, count);
      steps = 2;
      this.addLog(`${this.players[nextPlayer].name} 罚抽 ${count} 张并跳过回合`);
    }

    this.currentPlayer = this.advance(steps);
    this.phase = 'turn';
    this.drawnCardId = null;
    this.pendingPlay = null;
    this.turn += 1;
    return { played: card.id };
  }

  chooseColor(color) {
    if (this.phase !== 'color' || !this.pendingPlay) throw new Error('当前不需要选择颜色');
    if (!COLORS.includes(color)) throw new Error('无效的颜色');
    const pending = this.pendingPlay;
    this.phase = pending.resumePhase;
    this.pendingPlay = null;
    return this.playCard(pending.cardId, { color, uno: pending.uno });
  }
}
