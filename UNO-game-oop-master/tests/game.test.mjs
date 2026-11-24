import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, UnoGame, createDeck } from '../web/js/game.mjs';
import { chooseAiMove } from '../web/js/ai.mjs';

const cards = createDeck();
const card = (id) => cards.find((item) => item.id === id);
const makeGame = (playerCount = 3) => new UnoGame({ playerCount, random: () => 0.42 });

function prepare(game, hand, top, color = top.color) {
  game.players[0].hand = hand;
  game.players[0].unoDeclared = false;
  game.discardPile = [top];
  game.currentColor = color;
  game.currentPlayer = 0;
  game.direction = 1;
  game.phase = 'turn';
  game.drawnCardId = null;
  game.pendingPlay = null;
  game.winner = null;
}

test('牌堆包含 108 张牌且 ID、构成与原项目一致', () => {
  assert.equal(cards.length, 108);
  assert.equal(new Set(cards.map((item) => item.id)).size, 108);
  assert.equal(cards.filter((item) => item.type === 'wild').length, 4);
  assert.equal(cards.filter((item) => item.type === 'wildDrawFour').length, 4);
  assert.equal(cards.filter((item) => item.color === 'red').length, 25);
  assert.deepEqual(card(0), { id: 0, color: 'red', type: 'number', value: 0 });
  assert.deepEqual(card(107), { id: 107, color: 'wild', type: 'wildDrawFour', value: null });
});

test('2 到 8 人开局各发 7 张牌，首牌必为数字牌', () => {
  for (let count = 2; count <= 8; count += 1) {
    const game = makeGame(count);
    assert.equal(game.players.length, count);
    assert.ok(game.players.every((player) => player.hand.length === 7));
    assert.equal(game.topCard.type, 'number');
    assert.equal(game.deck.length, 108 - count * 7 - 1);
    assert.equal(game.currentPlayer, 0);
  }
  assert.throws(() => makeGame(1));
  assert.throws(() => makeGame(9));
});

test('允许同色、同数字、同功能及万能牌，拒绝不匹配卡牌', () => {
  const game = makeGame();
  prepare(game, [card(26), card(51), card(69), card(100)], card(1));
  assert.ok(game.canPlayCard(card(26)));
  assert.ok(game.canPlayCard(card(51)));
  prepare(game, [card(44), card(52), card(100)], card(19));
  assert.ok(game.canPlayCard(card(44)));
  assert.equal(game.canPlayCard(card(52)), false);
  assert.ok(game.canPlayCard(card(100)));
});

test('Wild Draw Four 仅在手中没有当前颜色时合法', () => {
  const game = makeGame();
  prepare(game, [card(104), card(3), card(52)], card(1));
  assert.equal(game.canPlayCard(card(104)), false);
  prepare(game, [card(104), card(26), card(52)], card(3));
  assert.ok(game.canPlayCard(card(104)));
});

test('Skip 跳过下家，Reverse 反转方向', () => {
  const skipGame = makeGame();
  prepare(skipGame, [card(19), card(52)], card(1));
  skipGame.playCard(19);
  assert.equal(skipGame.currentPlayer, 2);

  const reverseGame = makeGame();
  prepare(reverseGame, [card(23), card(52)], card(1));
  reverseGame.playCard(23);
  assert.equal(reverseGame.direction, -1);
  assert.equal(reverseGame.currentPlayer, 2);
});

test('双人 Reverse 等同 Skip', () => {
  const game = makeGame(2);
  prepare(game, [card(23), card(52)], card(1));
  game.playCard(23);
  assert.equal(game.currentPlayer, 0);
  assert.equal(game.direction, -1);
});

test('Draw Two 与 Wild Draw Four 罚牌并跳过下家', () => {
  const drawTwo = makeGame();
  prepare(drawTwo, [card(21), card(52)], card(1));
  const beforeTwo = drawTwo.players[1].hand.length;
  drawTwo.playCard(21);
  assert.equal(drawTwo.players[1].hand.length, beforeTwo + 2);
  assert.equal(drawTwo.currentPlayer, 2);

  const drawFour = makeGame();
  prepare(drawFour, [card(104), card(26)], card(3));
  const beforeFour = drawFour.players[1].hand.length;
  drawFour.playCard(104, { color: 'green' });
  assert.equal(drawFour.players[1].hand.length, beforeFour + 4);
  assert.equal(drawFour.currentPlayer, 2);
  assert.equal(drawFour.currentColor, 'green');
});

test('万能牌等待选色后再原子结算', () => {
  const game = makeGame();
  prepare(game, [card(100), card(52)], card(1));
  assert.deepEqual(game.playCard(100), { needsColor: true });
  assert.equal(game.phase, 'color');
  assert.equal(game.players[0].hand.length, 2);
  game.chooseColor('blue');
  assert.equal(game.phase, 'turn');
  assert.equal(game.currentColor, 'blue');
  assert.equal(game.topCard.id, 100);
  assert.equal(game.currentPlayer, 1);
});

test('抽牌后只能出所抽的合法牌或结束回合', () => {
  const game = makeGame();
  prepare(game, [card(2), card(52)], card(1));
  game.deck = [card(51)];
  const drawn = game.drawCard();
  assert.equal(drawn.id, 51);
  assert.deepEqual(game.getPlayableCards().map((item) => item.id), [51]);
  assert.throws(() => game.playCard(2));
  game.playCard(51);
  assert.equal(game.currentPlayer, 1);

  const passGame = makeGame();
  prepare(passGame, [card(28), card(53)], card(1));
  passGame.deck = [card(30)];
  passGame.drawCard();
  assert.deepEqual(passGame.getPlayableCards(), []);
  passGame.passTurn();
  assert.equal(passGame.currentPlayer, 1);
});

test('漏报 UNO 自动罚两张，提前宣告则不罚', () => {
  const penalized = makeGame();
  prepare(penalized, [card(1), card(3)], card(5));
  penalized.playCard(1);
  assert.equal(penalized.players[0].hand.length, 3);

  const declared = makeGame();
  prepare(declared, [card(1), card(3)], card(5));
  declared.declareUno();
  declared.playCard(1);
  assert.equal(declared.players[0].hand.length, 1);
});

test('最后一张牌合法打出后立即结算胜负', () => {
  const game = makeGame();
  prepare(game, [card(1)], card(5));
  const result = game.playCard(1);
  assert.deepEqual(result, { winner: 0 });
  assert.equal(game.phase, 'over');
  assert.equal(game.winner, 0);
  assert.deepEqual(game.getPlayableCards(), []);
});

test('牌堆耗尽时保留顶牌并重洗其余弃牌', () => {
  const game = makeGame();
  prepare(game, [card(26), card(52)], card(5));
  game.discardPile = [card(51), card(53), card(5)];
  game.deck = [];
  game.drawCard();
  assert.equal(game.players[0].hand.length, 3);
  assert.equal(game.deck.length, 1);
  assert.equal(game.discardPile.length, 1);
  assert.equal(game.topCard.id, 5);
});

test('AI 能选合法牌、自动 UNO，并在抽牌后处理过牌', () => {
  const game = makeGame();
  prepare(game, [card(1), card(3)], card(5));
  const move = chooseAiMove(game, () => 0);
  assert.deepEqual(move, { type: 'play', cardId: 1, color: COLORS[0], uno: true });

  prepare(game, [card(28), card(53)], card(1));
  assert.deepEqual(chooseAiMove(game), { type: 'draw' });
  game.deck = [card(30)];
  game.drawCard();
  assert.deepEqual(chooseAiMove(game), { type: 'pass' });
});
