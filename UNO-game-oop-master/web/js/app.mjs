import { COLOR_NAMES, COLORS, UnoGame } from './game.mjs?v=20261120';
import { chooseAiMove } from './ai.mjs?v=20261120';

const $ = (selector) => document.querySelector(selector);
const setupScreen = $('#setup-screen');
const gameScreen = $('#game-screen');
const setupForm = $('#setup-form');
const playerNameInput = $('#player-name');
const playerCountInput = $('#player-count');
const playerCountValue = $('#player-count-value');
const handElement = $('#hand');
const seatsElement = $('#seats');
const colorDialog = $('#color-dialog');
const resultDialog = $('#result-dialog');
const rulesDialog = $('#rules-dialog');
const drawPileButton = $('#draw-pile');
const passButton = $('#pass-button');
const unoButton = $('#uno-button');

const colorHex = { red: '#ed3838', yellow: '#ffd53d', blue: '#168bd2', green: '#2ba35c' };
const colorPrefix = { red: 'Red', yellow: 'Yellow', blue: 'Blue', green: 'Green' };
const typeNames = {
  skip: '禁止',
  drawTwo: '+2',
  reverse: '反转',
  wild: '万能牌',
  wildDrawFour: '万能 +4',
};
const seatPositions = {
  1: [[50, 9]],
  2: [[25, 11], [75, 11]],
  3: [[18, 18], [50, 8], [82, 18]],
  4: [[10, 43], [24, 10], [76, 10], [90, 43]],
  5: [[8, 44], [16, 13], [38, 7], [70, 7], [91, 19]],
  6: [[7, 45], [10, 17], [29, 7], [57, 7], [82, 10], [93, 39]],
  7: [[6, 50], [7, 24], [19, 9], [42, 6], [66, 6], [86, 12], [94, 38]],
};

let game = null;
let session = 0;
let aiTimer = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function cardImage(card) {
  if (card.type === 'wild') return '/UNO2D/Wild.jpg';
  if (card.type === 'wildDrawFour') return '/UNO2D/DrawFour.jpg';
  const prefix = colorPrefix[card.color];
  if (card.type === 'number') return `/UNO2D/${prefix}${card.value}.jpg`;
  if (card.type === 'skip') return card.color === 'red' ? '/UNO2D/RedSikp.jpg' : `/UNO2D/${prefix}Skip.jpg`;
  if (card.type === 'drawTwo') return `/UNO2D/${prefix}Drawtwo.jpg`;
  return `/UNO2D/${prefix}Reverse.jpg`;
}

function cardLabel(card) {
  const color = card.color === 'wild' ? '黑色' : COLOR_NAMES[card.color];
  return `${color}${card.type === 'number' ? card.value : typeNames[card.type]}`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

function startGame() {
  session += 1;
  clearTimeout(aiTimer);
  game = new UnoGame({
    playerCount: Number(playerCountInput.value),
    playerName: playerNameInput.value,
  });
  if (resultDialog.open) resultDialog.close();
  if (colorDialog.open) colorDialog.close();
  setupScreen.classList.add('is-hidden');
  gameScreen.classList.remove('is-hidden');
  render();
  queueAi();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function returnHome() {
  session += 1;
  clearTimeout(aiTimer);
  game = null;
  for (const dialog of [resultDialog, colorDialog, rulesDialog]) {
    if (dialog.open) dialog.close();
  }
  gameScreen.classList.add('is-hidden');
  setupScreen.classList.remove('is-hidden');
}

function render() {
  if (!game) return;
  const humanTurn = game.currentPlayer === 0 && game.phase !== 'over';
  const playableIds = new Set(humanTurn ? game.getPlayableCards().map((card) => card.id) : []);
  const human = game.players[0];

  $('#deck-count').textContent = game.deck.length;
  $('#discard-card').src = cardImage(game.topCard);
  $('#discard-card').alt = cardLabel(game.topCard);
  $('#current-color-name').textContent = COLOR_NAMES[game.currentColor];
  $('#color-dot').style.background = colorHex[game.currentColor];
  $('#direction-indicator').textContent = game.direction === 1 ? '↻ 顺时针' : '↺ 逆时针';
  $('#turn-number').textContent = game.turn;
  $('#human-card-count').textContent = human.hand.length;
  $('#remaining-player-count').textContent = game.players.length;

  const currentName = game.currentPlayerData.name;
  const turnText = game.phase === 'over'
    ? `${game.players[game.winner].name} 获胜`
    : humanTurn ? '轮到你出牌' : `${currentName} 正在思考`;
  $('#turn-banner').textContent = turnText;
  $('#turn-banner').classList.toggle('is-mine', humanTurn);
  $('#status-title').textContent = game.phase === 'over' ? '本局结束' : humanTurn ? '你的回合' : `${currentName} 的回合`;
  $('#status-description').textContent = humanTurn
    ? '选择一张高亮卡牌，或从牌堆抽牌。'
    : game.phase === 'over' ? '可以再来一局，或返回首页调整人数。' : 'AI 正在选择下一步操作。';

  const positions = seatPositions[game.players.length - 1];
  seatsElement.innerHTML = game.players.slice(1).map((player, offset) => {
    const index = offset + 1;
    const [left, top] = positions[offset];
    const current = game.currentPlayer === index && game.phase !== 'over';
    return `<article class="seat${current ? ' is-current' : ''}" style="left:${left}%;top:${top}%">
      <div class="avatar-wrap">
        <img class="avatar" src="/UNO2D/${index}.png" alt="${escapeHtml(player.name)} 头像" />
        <span class="seat-card-count" title="剩余手牌">${player.hand.length}</span>
      </div>
      <span class="seat-name">${escapeHtml(player.name)}</span>
    </article>`;
  }).join('');

  const sortedHand = [...human.hand].sort((first, second) => {
    const firstColor = first.color === 'wild' ? 4 : COLORS.indexOf(first.color);
    const secondColor = second.color === 'wild' ? 4 : COLORS.indexOf(second.color);
    return firstColor - secondColor || first.id - second.id;
  });
  handElement.innerHTML = sortedHand.map((card) => {
    const playable = playableIds.has(card.id);
    const drawn = game.drawnCardId === card.id && humanTurn;
    return `<button class="game-card${playable ? ' is-playable' : ''}${drawn ? ' is-drawn' : ''}" data-card-id="${card.id}" type="button" aria-label="${cardLabel(card)}${playable ? '，可以打出' : '，当前不可打出'}" ${playable ? '' : 'disabled'}>
      <img src="${cardImage(card)}" alt="${cardLabel(card)}" draggable="false" />
    </button>`;
  }).join('');

  drawPileButton.disabled = !humanTurn || game.phase !== 'turn';
  passButton.classList.toggle('is-hidden', !humanTurn || game.phase !== 'drawn');
  unoButton.disabled = !humanTurn || game.phase !== 'turn' || human.hand.length !== 2 || human.unoDeclared;
  unoButton.classList.toggle('is-declared', human.unoDeclared);
  unoButton.textContent = human.unoDeclared ? '已喊 UNO!' : '喊 UNO!';

  let hint = '轮到你时，高亮卡牌可以打出。';
  if (game.phase === 'color') hint = '请在弹窗中选择万能牌的颜色。';
  else if (game.phase === 'over') hint = `${game.players[game.winner].name} 已出完全部手牌。`;
  else if (!humanTurn) hint = `${currentName} 正在思考，请稍候。`;
  else if (game.phase === 'drawn') hint = playableIds.size ? '可以打出蓝色边框的抽牌，或结束回合。' : '抽到的牌不能打出，请点击“结束回合”。';
  else if (human.hand.length === 2 && !human.unoDeclared) hint = '只剩两张牌，出牌前记得先喊 UNO。';
  else if (playableIds.size === 0) hint = '当前没有可出的牌，请从牌堆抽一张。';
  else hint = '选择黄色边框的卡牌打出，或点击卡背抽牌。';
  $('#action-hint').textContent = hint;

  const recentLogs = game.log.slice(-7).reverse();
  $('#activity-log').innerHTML = recentLogs.map((message) => `<li>${escapeHtml(message)}</li>`).join('');

  if (game.phase === 'color' && !colorDialog.open) colorDialog.showModal();
  if (game.phase === 'over' && !resultDialog.open) showResult();
}

function showResult() {
  const humanWon = game.winner === 0;
  $('#result-title').textContent = humanWon ? '你赢了！' : `${game.players[game.winner].name} 获胜`;
  $('#result-description').textContent = humanWon ? '最后一张牌落定，漂亮的一局。' : '差一点就赢了，再来一局扳回来吧。';
  $('#result-mark').textContent = humanWon ? 'UNO!' : '再来一局';
  resultDialog.showModal();
}

function queueAi(delay = 720) {
  clearTimeout(aiTimer);
  if (!game || game.phase === 'over' || game.phase === 'color' || game.currentPlayer === 0) return;
  const activeSession = session;
  aiTimer = setTimeout(() => {
    if (!game || activeSession !== session || game.currentPlayer === 0 || game.phase === 'over') return;
    try {
      const move = chooseAiMove(game);
      if (move.type === 'draw') game.drawCard();
      else if (move.type === 'pass') game.passTurn();
      else game.playCard(move.cardId, { color: move.color, uno: move.uno });
      render();
      queueAi(move.type === 'draw' ? 560 : 720);
    } catch (error) {
      showToast(error.message);
    }
  }, delay);
}

function perform(action) {
  if (!game) return;
  clearTimeout(aiTimer);
  try {
    action();
    render();
    queueAi();
  } catch (error) {
    showToast(error.message);
    render();
  }
}

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startGame();
});

playerCountInput.addEventListener('input', () => {
  playerCountValue.textContent = `${playerCountInput.value} 人`;
});

handElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-card-id]');
  if (!button || button.disabled) return;
  perform(() => game.playCard(Number(button.dataset.cardId)));
});

drawPileButton.addEventListener('click', () => perform(() => game.drawCard()));
passButton.addEventListener('click', () => perform(() => game.passTurn()));
unoButton.addEventListener('click', () => perform(() => {
  game.declareUno();
  showToast('UNO 宣告成功，现在打出倒数第二张牌');
}));

colorDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-color]');
  if (!button) return;
  perform(() => {
    game.chooseColor(button.dataset.color);
    colorDialog.close();
  });
});
colorDialog.addEventListener('cancel', (event) => event.preventDefault());
resultDialog.addEventListener('cancel', (event) => event.preventDefault());

$('#restart-button').addEventListener('click', startGame);
$('#play-again-button').addEventListener('click', startGame);
$('#exit-button').addEventListener('click', returnHome);
$('#result-home-button').addEventListener('click', returnHome);
$('#rules-button').addEventListener('click', () => rulesDialog.showModal());
$('#close-rules-button').addEventListener('click', () => rulesDialog.close());
rulesDialog.addEventListener('click', (event) => {
  if (event.target === rulesDialog) rulesDialog.close();
});
