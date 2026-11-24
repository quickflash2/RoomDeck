package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type unoSequenceRandom struct{ state uint64 }

func (r *unoSequenceRandom) next(n int) int {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	return int((r.state >> 32) % uint64(n))
}

func fixedUnoRandom(int) int { return 0 }

func unoTestCard(id int, color, kind string, value ...int) unoCard {
	card := unoCard{ID: id, Color: color, Type: kind}
	if len(value) > 0 {
		v := value[0]
		card.Value = &v
	}
	return card
}

func newUnoTestGame(playerCount int) *gameState {
	players := make([]gamePlayer, playerCount)
	for i := range players {
		players[i] = gamePlayer{ID: fmt.Sprintf("player-%d", i), Name: fmt.Sprintf("Player %d", i), Alive: true}
	}
	return &gameState{
		ID:      "uno-test",
		Kind:    "uno",
		Phase:   "turn",
		Round:   1,
		Players: players,
		Uno: &unoState{
			PlayerCount:  playerCount,
			Hands:        make([][]unoCard, playerCount),
			Discard:      []unoCard{unoTestCard(0, "red", "number", 5)},
			CurrentColor: "red",
			Direction:    1,
			Log:          []string{},
		},
	}
}

func populatedUnoTestGame(playerCount int) *gameState {
	g := newUnoTestGame(playerCount)
	nextID := 1
	for seat := range playerCount {
		for i := range 3 {
			g.Uno.Hands[seat] = append(g.Uno.Hands[seat], unoTestCard(nextID, unoColors[(seat+i)%len(unoColors)], "number", (seat*3+i)%9+1))
			nextID++
		}
	}
	for i := range 12 {
		g.Uno.Deck = append(g.Uno.Deck, unoTestCard(nextID, unoColors[i%len(unoColors)], "number", i%9+1))
		nextID++
	}
	return g
}

func unoCardCount(g *gameState) int {
	total := len(g.Uno.Deck) + len(g.Uno.Discard)
	for _, hand := range g.Uno.Hands {
		total += len(hand)
	}
	return total
}

func assertUnoConservation(t *testing.T, g *gameState, want int) {
	t.Helper()
	if got := unoCardCount(g); got != want {
		t.Fatalf("card total = %d, want %d", got, want)
	}
	seen := map[int]string{}
	check := func(zone string, cards []unoCard) {
		for _, card := range cards {
			if previous, exists := seen[card.ID]; exists {
				t.Fatalf("card %d duplicated in %s and %s", card.ID, previous, zone)
			}
			seen[card.ID] = zone
		}
	}
	check("deck", g.Uno.Deck)
	check("discard", g.Uno.Discard)
	for seat, hand := range g.Uno.Hands {
		check(fmt.Sprintf("hand-%d", seat), hand)
	}
}

func TestUnoDeckAndInitialDeal(t *testing.T) {
	deck := newUnoDeck()
	if len(deck) != 108 {
		t.Fatalf("deck has %d cards", len(deck))
	}
	ids := map[int]bool{}
	colors := map[string]int{}
	types := map[string]int{}
	for _, card := range deck {
		if ids[card.ID] {
			t.Fatalf("duplicate card id %d", card.ID)
		}
		ids[card.ID] = true
		colors[card.Color]++
		types[card.Type]++
		if card.Type == "number" && card.Value == nil || card.Type != "number" && card.Value != nil {
			t.Fatalf("invalid number value on %+v", card)
		}
	}
	for _, color := range unoColors {
		if colors[color] != 25 {
			t.Fatalf("%s has %d cards", color, colors[color])
		}
	}
	if colors["wild"] != 8 || types["wild"] != 4 || types["wildDrawFour"] != 4 {
		t.Fatalf("invalid wild cards: colors=%v types=%v", colors, types)
	}

	for _, playerCount := range []int{2, 8} {
		g := newUnoTestGame(playerCount)
		g.Uno = newUnoState(playerCount, fixedUnoRandom)
		for seat, hand := range g.Uno.Hands {
			if len(hand) != 7 {
				t.Fatalf("%d players seat %d has %d cards", playerCount, seat, len(hand))
			}
		}
		if len(g.Uno.Deck) != 107-7*playerCount {
			t.Fatalf("%d players deck has %d cards", playerCount, len(g.Uno.Deck))
		}
		top := g.unoTopCard()
		if top == nil || top.Type != "number" || g.Uno.CurrentColor != top.Color {
			t.Fatalf("invalid first card %+v", top)
		}
		assertUnoConservation(t, g, 108)
	}
}

func TestUnoCardLegalityAndDrawnRestriction(t *testing.T) {
	g := newUnoTestGame(2)
	g.Uno.Hands[0] = []unoCard{
		unoTestCard(1, "red", "number", 7),
		unoTestCard(2, "blue", "number", 5),
		unoTestCard(3, "blue", "skip"),
		unoTestCard(4, "wild", "wild"),
		unoTestCard(5, "wild", "wildDrawFour"),
	}
	for _, id := range []int{1, 2, 4} {
		if !g.unoCanPlay(g.Uno.Hands[0][id-1], 0) {
			t.Fatalf("card %d should be playable", id)
		}
	}
	if g.unoCanPlay(g.Uno.Hands[0][2], 0) {
		t.Fatal("off-color skip matched a number")
	}
	if g.unoCanPlay(g.Uno.Hands[0][4], 0) {
		t.Fatal("wild draw four allowed while holding current color")
	}
	g.Uno.Hands[0] = []unoCard{unoTestCard(2, "blue", "number", 5), unoTestCard(5, "wild", "wildDrawFour")}
	if !g.unoCanPlay(g.Uno.Hands[0][1], 0) {
		t.Fatal("wild draw four rejected without current color")
	}
	g.Uno.Discard = []unoCard{unoTestCard(6, "red", "skip")}
	if !g.unoCanPlay(unoTestCard(7, "blue", "skip"), 0) {
		t.Fatal("matching action type rejected")
	}

	g = newUnoTestGame(2)
	g.Uno.Hands[0] = []unoCard{unoTestCard(10, "red", "number", 7), unoTestCard(11, "blue", "number", 5)}
	g.Uno.Deck = []unoCard{unoTestCard(12, "red", "number", 8)}
	if code := g.drawUnoCard(0, fixedUnoRandom); code != "" {
		t.Fatal(code)
	}
	if g.Phase != "drawn" || g.Uno.DrawnCardID == nil || *g.Uno.DrawnCardID != 12 || g.Round != 1 {
		t.Fatalf("invalid drawn state %+v", g.Uno)
	}
	playable := g.unoPlayable(0)
	if len(playable) != 1 || playable[0].ID != 12 {
		t.Fatalf("drawn phase exposed other playable cards: %+v", playable)
	}
	if code := g.playUnoCard(0, 10, "", false, fixedUnoRandom); code == "" {
		t.Fatal("played a non-drawn card after drawing")
	}
	if code := g.playUnoCard(0, 12, "", false, fixedUnoRandom); code != "" {
		t.Fatal(code)
	}
	if g.Round != 2 || g.Phase != "turn" {
		t.Fatalf("completed play did not advance round: phase=%s round=%d", g.Phase, g.Round)
	}
}

func TestUnoActionCardsAndRoundAdvance(t *testing.T) {
	tests := []struct {
		name          string
		players       int
		card          unoCard
		color         string
		wantTurn      int
		wantDirection int
		wantTarget    int
	}{
		{name: "skip", players: 3, card: unoTestCard(100, "red", "skip"), wantTurn: 2, wantDirection: 1, wantTarget: 3},
		{name: "reverse three players", players: 3, card: unoTestCard(100, "red", "reverse"), wantTurn: 2, wantDirection: -1, wantTarget: 3},
		{name: "reverse two players acts as skip", players: 2, card: unoTestCard(100, "red", "reverse"), wantTurn: 0, wantDirection: -1, wantTarget: 3},
		{name: "draw two", players: 3, card: unoTestCard(100, "red", "drawTwo"), wantTurn: 2, wantDirection: 1, wantTarget: 5},
		{name: "wild draw four", players: 3, card: unoTestCard(100, "wild", "wildDrawFour"), color: "green", wantTurn: 2, wantDirection: 1, wantTarget: 7},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			g := populatedUnoTestGame(test.players)
			g.Uno.Hands[0][0] = test.card
			total := unoCardCount(g)
			if code := g.playUnoCard(0, test.card.ID, test.color, false, fixedUnoRandom); code != "" {
				t.Fatal(code)
			}
			if g.Turn != test.wantTurn || g.Uno.Direction != test.wantDirection || g.Round != 2 {
				t.Fatalf("turn=%d direction=%d round=%d", g.Turn, g.Uno.Direction, g.Round)
			}
			if len(g.Uno.Hands[1]) != test.wantTarget {
				t.Fatalf("target has %d cards, want %d", len(g.Uno.Hands[1]), test.wantTarget)
			}
			if test.color != "" && g.Uno.CurrentColor != test.color {
				t.Fatalf("current color = %s", g.Uno.CurrentColor)
			}
			assertUnoConservation(t, g, total)
		})
	}
}

func TestUnoDeclarationPenaltyWildChoiceAndWin(t *testing.T) {
	t.Run("declared UNO avoids penalty", func(t *testing.T) {
		g := newUnoTestGame(2)
		g.Uno.Hands[0] = []unoCard{unoTestCard(1, "red", "number", 7), unoTestCard(2, "blue", "number", 8)}
		g.Uno.Deck = []unoCard{unoTestCard(3, "green", "number", 1), unoTestCard(4, "green", "number", 2)}
		if code := g.declareUno(0); code != "" || !g.Players[0].UNODeclared {
			t.Fatalf("declare: %s", code)
		}
		if code := g.playUnoCard(0, 1, "", false, fixedUnoRandom); code != "" {
			t.Fatal(code)
		}
		if len(g.Uno.Hands[0]) != 1 || g.Players[0].UNODeclared {
			t.Fatalf("declared player was penalized: %+v", g.Uno.Hands[0])
		}
	})

	t.Run("missing UNO draws two", func(t *testing.T) {
		g := newUnoTestGame(2)
		g.Uno.Hands[0] = []unoCard{unoTestCard(1, "red", "number", 7), unoTestCard(2, "blue", "number", 8)}
		g.Uno.Deck = []unoCard{unoTestCard(3, "green", "number", 1), unoTestCard(4, "green", "number", 2)}
		total := unoCardCount(g)
		if code := g.playUnoCard(0, 1, "", false, fixedUnoRandom); code != "" {
			t.Fatal(code)
		}
		if len(g.Uno.Hands[0]) != 3 {
			t.Fatalf("hand has %d cards after penalty", len(g.Uno.Hands[0]))
		}
		assertUnoConservation(t, g, total)
	})

	t.Run("wild requires color", func(t *testing.T) {
		g := populatedUnoTestGame(2)
		g.Uno.Hands[0][0] = unoTestCard(100, "wild", "wild")
		total := unoCardCount(g)
		if code := g.playUnoCard(0, 100, "", false, fixedUnoRandom); code == "" {
			t.Fatal("wild played without a color")
		}
		if g.Round != 1 || len(g.Uno.Hands[0]) != 3 {
			t.Fatal("invalid wild play mutated state")
		}
		if code := g.playUnoCard(0, 100, "blue", false, fixedUnoRandom); code != "" || g.Uno.CurrentColor != "blue" {
			t.Fatalf("valid wild: code=%s color=%s", code, g.Uno.CurrentColor)
		}
		assertUnoConservation(t, g, total)
	})

	t.Run("winning play finishes without round increment or hand exposure", func(t *testing.T) {
		g := newUnoTestGame(2)
		g.Uno.Hands[0] = []unoCard{unoTestCard(1, "red", "drawTwo")}
		g.Uno.Hands[1] = []unoCard{unoTestCard(2, "blue", "number", 8)}
		targetCards := len(g.Uno.Hands[1])
		if code := g.playUnoCard(0, 1, "", false, fixedUnoRandom); code != "" {
			t.Fatal(code)
		}
		if g.Phase != "finished" || g.Uno.WinnerID != "player-0" || g.Round != 1 {
			t.Fatalf("winner state: phase=%s winner=%s round=%d", g.Phase, g.Uno.WinnerID, g.Round)
		}
		if len(g.Uno.Hands[1]) != targetCards {
			t.Fatal("winning draw two applied its penalty after the game ended")
		}
		raw, err := json.Marshal(makeUnoView(g, &principal{ID: "player-0"}))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(raw, []byte(`"hand"`)) || bytes.Contains(raw, []byte(`"deck"`)) || bytes.Contains(raw, []byte(`"discard"`)) {
			t.Fatalf("finished view exposed cards: %s", raw)
		}
	})
}

func TestUnoReshuffleEmptyDrawAndPass(t *testing.T) {
	g := newUnoTestGame(2)
	g.Uno.Deck = nil
	g.Uno.Discard = []unoCard{
		unoTestCard(1, "blue", "number", 2),
		unoTestCard(2, "green", "number", 3),
		unoTestCard(3, "red", "number", 5),
	}
	total := unoCardCount(g)
	if code := g.drawUnoCard(0, fixedUnoRandom); code != "" {
		t.Fatal(code)
	}
	if len(g.Uno.Deck) != 1 || len(g.Uno.Discard) != 1 || g.Uno.Discard[0].ID != 3 || g.Uno.DrawnCardID == nil {
		t.Fatalf("reshuffle state: deck=%+v discard=%+v drawn=%v", g.Uno.Deck, g.Uno.Discard, g.Uno.DrawnCardID)
	}
	assertUnoConservation(t, g, total)
	if code := g.passUnoTurn(0); code != "" || g.Round != 2 || g.Turn != 1 {
		t.Fatalf("pass after reshuffle: code=%s round=%d turn=%d", code, g.Round, g.Turn)
	}

	g = newUnoTestGame(2)
	g.Uno.Deck = nil
	if code := g.drawUnoCard(0, fixedUnoRandom); code != "" {
		t.Fatal(code)
	}
	if g.Phase != "drawn" || g.Uno.DrawnCardID != nil {
		t.Fatalf("empty draw did not enter drawn state: %+v", g.Uno)
	}
	if code := g.passUnoTurn(0); code != "" || g.Phase != "turn" || g.Round != 2 {
		t.Fatalf("empty draw could not pass: code=%s phase=%s round=%d", code, g.Phase, g.Round)
	}
}

func automaticUnoAction(g *gameState, random func(int) int) string {
	seat := g.Turn
	playable := g.unoPlayable(seat)
	if g.Phase == "drawn" {
		if len(playable) == 0 {
			return g.passUnoTurn(seat)
		}
		card := playable[0]
		color := ""
		if card.Color == "wild" {
			color = chooseUnoColor(g.Uno.Hands[seat], random)
		}
		return g.playUnoCard(seat, card.ID, color, len(g.Uno.Hands[seat]) == 2, random)
	}
	if g.Phase != "turn" {
		return "GAME_PHASE"
	}
	if len(playable) == 0 {
		return g.drawUnoCard(seat, random)
	}
	card := playable[random(len(playable))]
	color := ""
	if card.Color == "wild" {
		color = chooseUnoColor(g.Uno.Hands[seat], random)
	}
	return g.playUnoCard(seat, card.ID, color, len(g.Uno.Hands[seat]) == 2, random)
}

func TestUnoAIAutomaticAndCompleteSimulation(t *testing.T) {
	random := &unoSequenceRandom{state: 42}
	g := newUnoTestGame(4)
	for i := 1; i < len(g.Players); i++ {
		g.Players[i].AI = true
		g.Players[i].Name = fmt.Sprintf("AI %d", i)
	}
	g.Uno = newUnoState(4, random.next)
	advanced := false
	for step := 0; step < 20 && g.Phase != "finished"; step++ {
		before := g.Round
		if code := automaticUnoAction(g, random.next); code != "" {
			t.Fatal(code)
		}
		if g.Round != before {
			advanced = true
			if code := g.runUnoAI(random.next); code != "" {
				t.Fatal(code)
			}
		}
		if g.Phase != "finished" && g.Players[g.Turn].AI {
			t.Fatal("AI turn remained pending after synchronous settlement")
		}
		assertUnoConservation(t, g, 108)
	}
	if !advanced {
		t.Fatal("test did not complete a human turn")
	}

	g = newUnoTestGame(4)
	g.Uno = newUnoState(4, random.next)
	finished := false
	for step := 0; step < 50000; step++ {
		if g.Phase == "finished" {
			finished = true
			break
		}
		if code := automaticUnoAction(g, random.next); code != "" {
			t.Fatalf("simulation step %d: %s", step, code)
		}
		if got := unoCardCount(g); got != 108 {
			t.Fatalf("simulation step %d has %d cards", step, got)
		}
	}
	if !finished || g.Uno.WinnerID == "" {
		t.Fatalf("simulation did not finish: phase=%s round=%d winner=%s", g.Phase, g.Round, g.Uno.WinnerID)
	}
	assertUnoConservation(t, g, 108)
}

func unoCommandFor(g *unoGameView, action string) gameCommand {
	command := gameCommand{Action: action, Kind: "uno", Language: "en"}
	if g != nil {
		command.GameID = g.ID
		command.Round = g.Round
		command.Phase = g.Phase
		command.Version = g.Version
	}
	return command
}

func unoRequest(t *testing.T, f *fixture, client *http.Client, g *unoGameView, action string, want int, configure func(*gameCommand)) *unoGameView {
	t.Helper()
	command := unoCommandFor(g, action)
	if configure != nil {
		configure(&command)
	}
	path := f.path("/games")
	if action != "create" {
		path = f.path("/games/" + g.ID)
	}
	if want != 200 {
		f.request(t, client, "POST", path, command, want, nil)
		return g
	}
	var next unoGameView
	f.request(t, client, "POST", path, command, 200, &next)
	return &next
}

func assertUnoPublicJSON(t *testing.T, raw []byte) {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"uno", "deck", "discard", "hands"} {
		if _, exists := object[key]; exists {
			t.Fatalf("public response contains %s: %s", key, raw)
		}
	}
	var players []map[string]json.RawMessage
	if err := json.Unmarshal(object["players"], &players); err != nil {
		t.Fatal(err)
	}
	for _, player := range players {
		if _, exists := player["hand"]; exists {
			t.Fatalf("public player contains hand: %s", raw)
		}
	}
}

func TestUnoHTTPMixedHumansAIPrivacyAndVersions(t *testing.T) {
	f := newFixture(t)
	f.request(t, f.other, "POST", "/join", joinInput{Code: f.room.Code, Name: "Spectator"}, 201, nil)
	unoRequest(t, f, f.guest, nil, "create", 403, func(command *gameCommand) { command.PlayerCount = 4 })
	for _, count := range []int{1, 9} {
		unoRequest(t, f, f.host, nil, "create", 400, func(command *gameCommand) { command.PlayerCount = count })
	}
	g := unoRequest(t, f, f.host, nil, "create", 200, nil)
	if g.PlayerCount != 4 || g.Phase != "lobby" {
		t.Fatalf("default UNO lobby: %+v", g)
	}
	unoRequest(t, f, f.host, g, "start", 409, nil)
	g = unoRequest(t, f, f.host, g, "join", 200, nil)
	unoRequest(t, f, f.host, g, "join", 409, nil)
	g = unoRequest(t, f, f.guest, g, "join", 200, nil)
	g = unoRequest(t, f, f.host, g, "start", 200, nil)
	if g.Phase != "turn" || g.Round != 1 || len(g.Players) != 4 || g.DeckCount != 79 {
		t.Fatalf("started game: phase=%s round=%d players=%d deck=%d", g.Phase, g.Round, len(g.Players), g.DeckCount)
	}
	if g.Players[0].AI || g.Players[1].AI || !g.Players[2].AI || !g.Players[3].AI || g.Players[2].Name != "AI 1" || g.Players[3].Name != "AI 2" {
		t.Fatalf("unexpected seats: %+v", g.Players)
	}
	for _, player := range g.Players {
		if player.CardCount != 7 {
			t.Fatalf("seat %s has %d cards", player.ID, player.CardCount)
		}
	}
	unoRequest(t, f, f.other, g, "join", 409, nil)
	unoRequest(t, f, f.guest, g, "leave", 409, nil)
	unoRequest(t, f, f.guest, g, "start", 409, nil)

	var hostView, guestView, spectatorView unoGameView
	hostRaw := f.request(t, f.host, "GET", f.path("/games/"+g.ID), nil, 200, &hostView)
	guestRaw := f.request(t, f.guest, "GET", f.path("/games/"+g.ID), nil, 200, &guestView)
	f.request(t, f.other, "GET", f.path("/games/"+g.ID), nil, 200, &spectatorView)
	assertUnoPublicJSON(t, hostRaw)
	assertUnoPublicJSON(t, guestRaw)
	if hostView.Mine == nil || guestView.Mine == nil || len(hostView.Mine.Hand) != 7 || len(guestView.Mine.Hand) != 7 {
		t.Fatal("seated humans did not receive their own hands")
	}
	if spectatorView.Mine != nil {
		t.Fatal("spectator received a private hand")
	}
	for _, hostCard := range hostView.Mine.Hand {
		for _, guestCard := range guestView.Mine.Hand {
			if hostCard.ID == guestCard.ID {
				t.Fatalf("card %d appeared in both private hands", hostCard.ID)
			}
		}
	}
	var pair map[string]string
	f.request(t, f.host, "POST", f.path("/display-session"), nil, 201, &pair)
	display := client()
	f.request(t, display, "POST", "/display-exchange", pair, 200, nil)
	var displayView unoGameView
	displayRaw := f.request(t, display, "GET", f.path("/games/"+g.ID+"?display=1"), nil, 200, &displayView)
	assertUnoPublicJSON(t, displayRaw)
	if displayView.Mine != nil {
		t.Fatal("display received a private hand")
	}

	unoRequest(t, f, f.guest, g, "draw", 409, nil)
	oldVersion := g.Version
	drawCommand := unoCommandFor(g, "draw")
	var drawn unoGameView
	f.request(t, f.host, "POST", f.path("/games/"+g.ID), drawCommand, 200, &drawn)
	f.request(t, f.host, "POST", f.path("/games/"+g.ID), drawCommand, 409, nil)
	if drawn.Version != oldVersion+1 || drawn.Phase != "drawn" || drawn.Round != g.Round || drawn.Mine == nil || drawn.Mine.DrawnCardID == nil {
		t.Fatalf("invalid HTTP drawn state: %+v", drawn)
	}
	g = &drawn
	var guestDrawn unoGameView
	guestRaw = f.request(t, f.guest, "GET", f.path("/games/"+g.ID), nil, 200, &guestDrawn)
	if guestDrawn.Mine == nil || guestDrawn.Mine.DrawnCardID != nil || len(guestDrawn.Mine.PlayableCardIDs) != 0 {
		t.Fatal("another player received drawn-card secrets or actions")
	}
	if bytes.Contains(guestRaw, []byte(fmt.Sprintf(`"id":%d`, *g.Mine.DrawnCardID))) {
		t.Fatal("drawn card id leaked to another player")
	}
	invalidCard := -1
	for _, card := range g.Mine.Hand {
		if g.Mine.DrawnCardID == nil || card.ID != *g.Mine.DrawnCardID {
			invalidCard = card.ID
			break
		}
	}
	unoRequest(t, f, f.host, g, "play", 409, func(command *gameCommand) { command.CardID = &invalidCard })
	badIdentity := unoCommandFor(g, "pass")
	badIdentity.GameID = "an-old-game"
	f.request(t, f.host, "POST", f.path("/games/"+g.ID), badIdentity, 409, nil)

	beforeRound := g.Round
	g = unoRequest(t, f, f.host, g, "pass", 200, nil)
	if g.Round != beforeRound+1 || g.CurrentPlayerID != g.Players[1].ID {
		t.Fatalf("human pass did not advance exactly one seat: %+v", g)
	}
	g = unoRequest(t, f, f.guest, g, "draw", 200, nil)
	beforeVersion := g.Version
	beforeRound = g.Round
	g = unoRequest(t, f, f.guest, g, "pass", 200, nil)
	if g.Version != beforeVersion+1 {
		t.Fatalf("AI settlement changed version from %d to %d", beforeVersion, g.Version)
	}
	if g.Round <= beforeRound || !strings.Contains(strings.Join(g.Log, "\n"), "AI ") {
		t.Fatal("AI actions missing after triggering human pass")
	}
	if g.Phase != "finished" && g.Players[g.Turn].AI {
		t.Fatal("HTTP response stopped on an AI turn")
	}

	f.request(t, f.host, "GET", f.path("/games/"+g.ID), nil, 200, &hostView)
	if hostView.Phase == "finished" && hostView.Result == "cancelled" {
		t.Fatal("AI seats were treated as revoked participants")
	}
	_, err := f.s.db.Exec("UPDATE participants SET revoked=1 WHERE id=?", guestID(t, f, f.guest))
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, f.host, "GET", f.path("/games/"+g.ID), nil, 200, &hostView)
	if hostView.Phase != "finished" || hostView.Result != "cancelled" || hostView.Mine != nil {
		t.Fatalf("revoked human did not cancel game safely: %+v", hostView)
	}
}

func TestUnoHTTPLobbyCapacityLeaveAndSingleHuman(t *testing.T) {
	f := newFixture(t)
	f.request(t, f.other, "POST", "/join", joinInput{Code: f.room.Code, Name: "Third"}, 201, nil)
	g := unoRequest(t, f, f.host, nil, "create", 200, func(command *gameCommand) { command.PlayerCount = 2 })
	g = unoRequest(t, f, f.host, g, "join", 200, nil)
	g = unoRequest(t, f, f.guest, g, "join", 200, nil)
	unoRequest(t, f, f.other, g, "join", 409, nil)
	g = unoRequest(t, f, f.guest, g, "leave", 200, nil)
	g = unoRequest(t, f, f.other, g, "join", 200, nil)
	g = unoRequest(t, f, f.host, g, "start", 200, nil)
	if len(g.Players) != 2 || g.Players[0].AI || g.Players[1].AI || g.Phase != "turn" {
		t.Fatalf("two-human game did not start correctly: %+v", g.Players)
	}

	f2 := newFixture(t)
	g = unoRequest(t, f2, f2.host, nil, "create", 200, func(command *gameCommand) { command.PlayerCount = 8 })
	g = unoRequest(t, f2, f2.host, g, "join", 200, nil)
	g = unoRequest(t, f2, f2.host, g, "start", 200, nil)
	if len(g.Players) != 8 || g.Players[1].Name != "AI 1" || g.Players[7].Name != "AI 7" || g.Phase != "turn" {
		t.Fatalf("single human did not receive consecutive AI seats: %+v", g.Players)
	}
}

func TestUnoHTTPRestartRestoresDrawnState(t *testing.T) {
	f := newFixture(t)
	g := unoRequest(t, f, f.host, nil, "create", 200, func(command *gameCommand) { command.PlayerCount = 2 })
	g = unoRequest(t, f, f.host, g, "join", 200, nil)
	g = unoRequest(t, f, f.host, g, "start", 200, nil)
	g = unoRequest(t, f, f.host, g, "draw", 200, nil)
	if g.Phase != "drawn" || g.Mine == nil || g.Mine.DrawnCardID == nil {
		t.Fatalf("expected drawn state before restart: %+v", g)
	}
	stored, err := f.s.loadGame(f.room.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	config := f.s.config
	f.s.Close()
	reopened, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored, err := reopened.loadGame(f.room.ID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.ID != stored.ID || restored.Version != stored.Version || restored.Phase != "drawn" || restored.Round != stored.Round || !reflect.DeepEqual(restored.Uno, stored.Uno) {
		t.Fatal("private UNO state changed across restart")
	}
	ts := httptest.NewServer(reopened.Handler())
	defer ts.Close()
	f.ts = ts
	var view unoGameView
	f.request(t, f.host, "GET", f.path("/games/"+g.ID), nil, 200, &view)
	if view.Mine == nil || !reflect.DeepEqual(view.Mine.Hand, restored.Uno.Hands[0]) || view.Mine.DrawnCardID == nil || *view.Mine.DrawnCardID != *restored.Uno.DrawnCardID {
		t.Fatal("private hand or drawn card not restored to its owner")
	}
	beforeVersion := view.Version
	view = *unoRequest(t, f, f.host, &view, "pass", 200, nil)
	if view.Version != beforeVersion+1 || view.Round <= restored.Round || view.Phase == "drawn" {
		t.Fatalf("restored drawn state could not pass: %+v", view)
	}
}
