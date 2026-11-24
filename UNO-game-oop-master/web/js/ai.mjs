import { COLORS } from './game.mjs?v=20261120';

export function chooseAiMove(game, random = Math.random) {
  if (game.phase === 'drawn') {
    const [card] = game.getPlayableCards();
    return card
      ? { type: 'play', cardId: card.id, color: chooseColor(game, random) }
      : { type: 'pass' };
  }

  const playable = game.getPlayableCards();
  if (playable.length === 0) return { type: 'draw' };
  const card = playable[Math.floor(random() * playable.length)];
  return {
    type: 'play',
    cardId: card.id,
    color: chooseColor(game, random),
    uno: game.currentPlayerData.hand.length === 2,
  };
}

function chooseColor(game, random) {
  const counts = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const card of game.currentPlayerData.hand) {
    if (card.color in counts) counts[card.color] += 1;
  }
  const highest = Math.max(...Object.values(counts));
  const candidates = COLORS.filter((color) => counts[color] === highest);
  return candidates[Math.floor(random() * candidates.length)];
}
