package server

import (
	"fmt"
	"strconv"
)

var unoColors = []string{"red", "yellow", "blue", "green"}

type unoCard struct {
	ID    int    `json:"id"`
	Color string `json:"color"`
	Type  string `json:"type"`
	Value *int   `json:"value"`
}

type unoState struct {
	PlayerCount  int         `json:"player_count"`
	Deck         []unoCard   `json:"deck"`
	Discard      []unoCard   `json:"discard"`
	Hands        [][]unoCard `json:"hands"`
	CurrentColor string      `json:"current_color"`
	Direction    int         `json:"direction"`
	DrawnCardID  *int        `json:"drawn_card_id"`
	WinnerID     string      `json:"winner_id"`
	Log          []string    `json:"log"`
}

type unoPublicPlayer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Alive       bool   `json:"alive"`
	Score       int    `json:"score"`
	Submitted   bool   `json:"submitted"`
	AI          bool   `json:"ai"`
	CardCount   int    `json:"card_count"`
	UNODeclared bool   `json:"uno_declared"`
}

type unoMineView struct {
	Hand            []unoCard `json:"hand"`
	DrawnCardID     *int      `json:"drawn_card_id"`
	PlayableCardIDs []int     `json:"playable_card_ids"`
}

type unoGameView struct {
	ID              string            `json:"id"`
	Kind            string            `json:"kind"`
	Phase           string            `json:"phase"`
	Language        string            `json:"language"`
	Version         int               `json:"version"`
	Round           int               `json:"round"`
	Turn            int               `json:"turn"`
	Players         []unoPublicPlayer `json:"players"`
	Candidates      []string          `json:"candidates"`
	Tie             bool              `json:"tie"`
	Result          string            `json:"result"`
	Die             int               `json:"die"`
	Mine            *unoMineView      `json:"mine"`
	PlayerCount     int               `json:"player_count"`
	CurrentPlayerID string            `json:"current_player_id"`
	TopCard         *unoCard          `json:"top_card"`
	CurrentColor    string            `json:"current_color"`
	Direction       int               `json:"direction"`
	DeckCount       int               `json:"deck_count"`
	WinnerID        string            `json:"winner_id"`
	Log             []string          `json:"log"`
}

func isUnoTurnAction(action string) bool {
	return action == "play" || action == "draw" || action == "pass" || action == "declare_uno"
}

func newUnoDeck() []unoCard {
	deck := make([]unoCard, 0, 108)
	nextID := 0
	add := func(color, kind string, value *int) {
		deck = append(deck, unoCard{ID: nextID, Color: color, Type: kind, Value: value})
		nextID++
	}
	for _, color := range unoColors {
		zero := 0
		add(color, "number", &zero)
		for value := 1; value <= 9; value++ {
			first, second := value, value
			add(color, "number", &first)
			add(color, "number", &second)
		}
		for _, kind := range []string{"skip", "drawTwo", "reverse"} {
			add(color, kind, nil)
			add(color, kind, nil)
		}
	}
	for range 4 {
		add("wild", "wild", nil)
	}
	for range 4 {
		add("wild", "wildDrawFour", nil)
	}
	return deck
}

func shuffleUnoCards(cards []unoCard, random func(int) int) []unoCard {
	result := append([]unoCard(nil), cards...)
	for i := len(result) - 1; i > 0; i-- {
		j := random(i + 1)
		result[i], result[j] = result[j], result[i]
	}
	return result
}

func newUnoState(playerCount int, random func(int) int) *unoState {
	u := &unoState{
		PlayerCount: playerCount,
		Hands:       make([][]unoCard, playerCount),
		Direction:   1,
		Log:         []string{},
	}
	u.Deck = shuffleUnoCards(newUnoDeck(), random)
	for range 7 {
		for seat := range playerCount {
			u.drawCards(seat, 1, random)
		}
	}
	first := -1
	for i, card := range u.Deck {
		if card.Type == "number" {
			first = i
			break
		}
	}
	card := u.Deck[first]
	u.Deck = append(u.Deck[:first], u.Deck[first+1:]...)
	u.Discard = []unoCard{card}
	u.CurrentColor = card.Color
	u.addLog("Game started with " + unoCardName(card))
	return u
}

func unoCardName(card unoCard) string {
	name := card.Color + " " + card.Type
	if card.Value != nil {
		name += " " + strconv.Itoa(*card.Value)
	}
	return name
}

func (u *unoState) addLog(message string) {
	u.Log = append(u.Log, message)
	if len(u.Log) > 40 {
		u.Log = append([]string(nil), u.Log[len(u.Log)-40:]...)
	}
}

func (u *unoState) takeCard(random func(int) int) *unoCard {
	if len(u.Deck) == 0 && len(u.Discard) > 1 {
		top := u.Discard[len(u.Discard)-1]
		u.Deck = shuffleUnoCards(u.Discard[:len(u.Discard)-1], random)
		u.Discard = []unoCard{top}
		if len(u.Deck) > 0 {
			u.addLog("Discard pile reshuffled")
		}
	}
	if len(u.Deck) == 0 {
		return nil
	}
	last := len(u.Deck) - 1
	card := u.Deck[last]
	u.Deck = u.Deck[:last]
	return &card
}

func (u *unoState) drawCards(seat, count int, random func(int) int) []unoCard {
	cards := []unoCard{}
	for range count {
		card := u.takeCard(random)
		if card == nil {
			break
		}
		u.Hands[seat] = append(u.Hands[seat], *card)
		cards = append(cards, *card)
	}
	return cards
}

func (g *gameState) unoTopCard() *unoCard {
	if g.Uno == nil || len(g.Uno.Discard) == 0 {
		return nil
	}
	card := g.Uno.Discard[len(g.Uno.Discard)-1]
	return &card
}

func (g *gameState) unoAdvance(steps int) int {
	count := len(g.Players)
	return ((g.Turn+g.Uno.Direction*steps)%count + count) % count
}

func (g *gameState) unoCanPlay(card unoCard, seat int) bool {
	top := g.unoTopCard()
	if top == nil || seat < 0 || seat >= len(g.Uno.Hands) {
		return false
	}
	if card.Type == "wild" {
		return true
	}
	if card.Type == "wildDrawFour" {
		for _, held := range g.Uno.Hands[seat] {
			if held.Color == g.Uno.CurrentColor {
				return false
			}
		}
		return true
	}
	if card.Color == g.Uno.CurrentColor {
		return true
	}
	if card.Type == "number" && top.Type == "number" && card.Value != nil && top.Value != nil {
		return *card.Value == *top.Value
	}
	return card.Type == top.Type && (card.Type == "skip" || card.Type == "drawTwo" || card.Type == "reverse")
}

func (g *gameState) unoPlayable(seat int) []unoCard {
	playable := []unoCard{}
	if g.Uno == nil || seat != g.Turn || seat < 0 || seat >= len(g.Uno.Hands) || (g.Phase != "turn" && g.Phase != "drawn") {
		return playable
	}
	for _, card := range g.Uno.Hands[seat] {
		if g.Phase == "drawn" && (g.Uno.DrawnCardID == nil || card.ID != *g.Uno.DrawnCardID) {
			continue
		}
		if g.unoCanPlay(card, seat) {
			playable = append(playable, card)
		}
	}
	return playable
}

func validUnoColor(color string) bool {
	for _, candidate := range unoColors {
		if color == candidate {
			return true
		}
	}
	return false
}

func (g *gameState) playUnoCard(seat, cardID int, color string, uno bool, random func(int) int) string {
	if g.Phase != "turn" && g.Phase != "drawn" {
		return "GAME_PHASE"
	}
	playable := g.unoPlayable(seat)
	cardIndex := -1
	found := false
	var card unoCard
	for _, candidate := range playable {
		if candidate.ID == cardID {
			card = candidate
			found = true
			break
		}
	}
	if !found {
		return "INVALID_INPUT"
	}
	for i, held := range g.Uno.Hands[seat] {
		if held.ID == cardID {
			cardIndex = i
			break
		}
	}
	if cardIndex < 0 {
		return "INVALID_INPUT"
	}
	if (card.Type == "wild" || card.Type == "wildDrawFour") && !validUnoColor(color) {
		return "INVALID_INPUT"
	}

	player := &g.Players[seat]
	wantsUno := uno || player.UNODeclared
	player.UNODeclared = false
	g.Uno.Hands[seat] = append(g.Uno.Hands[seat][:cardIndex], g.Uno.Hands[seat][cardIndex+1:]...)
	g.Uno.Discard = append(g.Uno.Discard, card)
	g.Uno.CurrentColor = card.Color
	if card.Color == "wild" {
		g.Uno.CurrentColor = color
	}
	g.Uno.addLog(player.Name + " played " + unoCardName(card))

	if len(g.Uno.Hands[seat]) == 1 && !wantsUno {
		g.Uno.drawCards(seat, 2, random)
		g.Uno.addLog(player.Name + " did not declare UNO and drew two penalty cards")
	}
	if len(g.Uno.Hands[seat]) == 0 {
		g.Uno.WinnerID = player.ID
		g.Phase = "finished"
		g.Result = "winner"
		g.Uno.DrawnCardID = nil
		g.Uno.addLog(player.Name + " won the game")
		return ""
	}

	steps := 1
	next := g.unoAdvance(1)
	switch card.Type {
	case "skip":
		steps = 2
		g.Uno.addLog(g.Players[next].Name + " was skipped")
	case "reverse":
		g.Uno.Direction *= -1
		if len(g.Players) == 2 {
			steps = 2
		}
		g.Uno.addLog("Play direction reversed")
	case "drawTwo", "wildDrawFour":
		count := 2
		if card.Type == "wildDrawFour" {
			count = 4
		}
		g.Uno.drawCards(next, count, random)
		steps = 2
		g.Uno.addLog(g.Players[next].Name + " drew " + strconv.Itoa(count) + " penalty cards and was skipped")
	}
	g.Turn = g.unoAdvance(steps)
	g.Phase = "turn"
	g.Round++
	g.Uno.DrawnCardID = nil
	return ""
}

func (g *gameState) drawUnoCard(seat int, random func(int) int) string {
	if g.Phase != "turn" || seat != g.Turn {
		return "GAME_PHASE"
	}
	cards := g.Uno.drawCards(seat, 1, random)
	g.Phase = "drawn"
	g.Uno.DrawnCardID = nil
	g.Players[seat].UNODeclared = false
	if len(cards) == 1 {
		id := cards[0].ID
		g.Uno.DrawnCardID = &id
		g.Uno.addLog(g.Players[seat].Name + " drew a card")
	} else {
		g.Uno.addLog(g.Players[seat].Name + " found no card to draw")
	}
	return ""
}

func (g *gameState) passUnoTurn(seat int) string {
	if g.Phase != "drawn" || seat != g.Turn {
		return "GAME_PHASE"
	}
	g.Uno.addLog(g.Players[seat].Name + " passed")
	g.Uno.DrawnCardID = nil
	g.Turn = g.unoAdvance(1)
	g.Phase = "turn"
	g.Round++
	return ""
}

func (g *gameState) declareUno(seat int) string {
	if g.Phase != "turn" || seat != g.Turn || len(g.Uno.Hands[seat]) != 2 {
		return "GAME_PHASE"
	}
	g.Players[seat].UNODeclared = true
	g.Uno.addLog(g.Players[seat].Name + " declared UNO")
	return ""
}

func chooseUnoColor(hand []unoCard, random func(int) int) string {
	counts := make(map[string]int, len(unoColors))
	for _, color := range unoColors {
		counts[color] = 0
	}
	for _, card := range hand {
		if _, ok := counts[card.Color]; ok {
			counts[card.Color]++
		}
	}
	highest := -1
	candidates := []string{}
	for _, color := range unoColors {
		if counts[color] > highest {
			highest = counts[color]
			candidates = []string{color}
		} else if counts[color] == highest {
			candidates = append(candidates, color)
		}
	}
	return candidates[random(len(candidates))]
}

func (g *gameState) runUnoAI(random func(int) int) string {
	for steps := 0; g.Phase != "finished" && g.Turn >= 0 && g.Turn < len(g.Players) && g.Players[g.Turn].AI; steps++ {
		if steps >= 128 {
			return "GAME_STATE"
		}
		seat := g.Turn
		playable := g.unoPlayable(seat)
		if g.Phase == "drawn" {
			if len(playable) == 0 {
				if code := g.passUnoTurn(seat); code != "" {
					return code
				}
				continue
			}
			card := playable[0]
			color := ""
			if card.Color == "wild" {
				color = chooseUnoColor(g.Uno.Hands[seat], random)
			}
			if code := g.playUnoCard(seat, card.ID, color, len(g.Uno.Hands[seat]) == 2, random); code != "" {
				return code
			}
			continue
		}
		if g.Phase != "turn" {
			return "GAME_STATE"
		}
		if len(playable) == 0 {
			if code := g.drawUnoCard(seat, random); code != "" {
				return code
			}
			continue
		}
		card := playable[random(len(playable))]
		color := ""
		if card.Color == "wild" {
			color = chooseUnoColor(g.Uno.Hands[seat], random)
		}
		if code := g.playUnoCard(seat, card.ID, color, len(g.Uno.Hands[seat]) == 2, random); code != "" {
			return code
		}
	}
	return ""
}

func (g *gameState) applyUno(in gameCommand, p *principal) string {
	if g.Uno == nil {
		return "GAME_PHASE"
	}
	index := -1
	for i, player := range g.Players {
		if player.ID == p.ID {
			index = i
			break
		}
	}
	switch in.Action {
	case "join":
		if g.Phase != "lobby" || index >= 0 {
			return "GAME_PHASE"
		}
		if len(g.Players) >= g.Uno.PlayerCount {
			return "GAME_FULL"
		}
		g.Players = append(g.Players, gamePlayer{ID: p.ID, Name: p.Name, Alive: true})
		return ""
	case "leave":
		if g.Phase != "lobby" || index < 0 {
			return "GAME_PHASE"
		}
		g.Players = append(g.Players[:index], g.Players[index+1:]...)
		return ""
	case "cancel":
		if p.Role != "host" {
			return "FORBIDDEN"
		}
		g.Phase = "finished"
		g.Result = "cancelled"
		g.Uno.WinnerID = ""
		g.Uno.DrawnCardID = nil
		for i := range g.Players {
			g.Players[i].UNODeclared = false
		}
		return ""
	case "start":
		if p.Role != "host" {
			return "FORBIDDEN"
		}
		if g.Phase != "lobby" || len(g.Players) == 0 {
			return "GAME_PLAYERS"
		}
		for number := 1; len(g.Players) < g.Uno.PlayerCount; number++ {
			g.Players = append(g.Players, gamePlayer{
				ID:    fmt.Sprintf("ai:%s:%d", g.ID, number),
				Name:  fmt.Sprintf("AI %d", number),
				Alive: true,
				AI:    true,
			})
		}
		g.Round = 1
		g.Turn = 0
		g.Phase = "turn"
		g.Result = ""
		g.Uno = newUnoState(len(g.Players), randomNumber)
		return g.runUnoAI(randomNumber)
	case "play", "draw", "pass", "declare_uno":
		if index < 0 || index != g.Turn || g.Players[index].AI {
			return "GAME_PHASE"
		}
		var code string
		switch in.Action {
		case "play":
			if in.CardID == nil {
				return "INVALID_INPUT"
			}
			code = g.playUnoCard(index, *in.CardID, in.Color, in.Uno, randomNumber)
		case "draw":
			code = g.drawUnoCard(index, randomNumber)
		case "pass":
			code = g.passUnoTurn(index)
		case "declare_uno":
			code = g.declareUno(index)
		}
		if code != "" {
			return code
		}
		if in.Action == "play" || in.Action == "pass" {
			return g.runUnoAI(randomNumber)
		}
		return ""
	default:
		return "INVALID_INPUT"
	}
}

func makeUnoView(g *gameState, p *principal) *unoGameView {
	u := g.Uno
	if u == nil {
		u = &unoState{PlayerCount: len(g.Players), Direction: 1, Log: []string{}}
	}
	view := &unoGameView{
		ID:           g.ID,
		Kind:         g.Kind,
		Phase:        g.Phase,
		Language:     g.Language,
		Version:      g.Version,
		Round:        g.Round,
		Turn:         g.Turn,
		Players:      []unoPublicPlayer{},
		Candidates:   g.Candidates,
		Tie:          g.Tie,
		Result:       g.Result,
		Die:          g.Die,
		PlayerCount:  u.PlayerCount,
		CurrentColor: u.CurrentColor,
		Direction:    u.Direction,
		DeckCount:    len(u.Deck),
		WinnerID:     u.WinnerID,
		Log:          append([]string{}, u.Log...),
		TopCard:      g.unoTopCard(),
	}
	if g.Phase != "lobby" && g.Turn >= 0 && g.Turn < len(g.Players) {
		view.CurrentPlayerID = g.Players[g.Turn].ID
	}
	seat := -1
	for i, player := range g.Players {
		count := 0
		if i < len(u.Hands) {
			count = len(u.Hands[i])
		}
		view.Players = append(view.Players, unoPublicPlayer{
			ID:          player.ID,
			Name:        player.Name,
			Alive:       player.Alive,
			Score:       player.Score,
			AI:          player.AI,
			CardCount:   count,
			UNODeclared: player.UNODeclared,
		})
		if p != nil && p.Role != "display" && !player.AI && player.ID == p.ID {
			seat = i
		}
	}
	if seat >= 0 && g.Phase != "finished" {
		mine := &unoMineView{Hand: []unoCard{}, PlayableCardIDs: []int{}}
		if seat < len(u.Hands) {
			mine.Hand = append(mine.Hand, u.Hands[seat]...)
		}
		if seat == g.Turn {
			mine.DrawnCardID = u.DrawnCardID
			for _, card := range g.unoPlayable(seat) {
				mine.PlayableCardIDs = append(mine.PlayableCardIDs, card.ID)
			}
		}
		view.Mine = mine
	}
	return view
}
