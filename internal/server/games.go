package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"time"
)

type gamePlayer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Alive       bool   `json:"alive"`
	Score       int    `json:"score"`
	Word        string `json:"word,omitempty"`
	Spy         bool   `json:"spy,omitempty"`
	Vote        string `json:"vote,omitempty"`
	Guess       int    `json:"guess,omitempty"`
	AI          bool   `json:"ai,omitempty"`
	UNODeclared bool   `json:"uno_declared,omitempty"`
}
type gameState struct {
	ID         string       `json:"id"`
	Kind       string       `json:"kind"`
	Phase      string       `json:"phase"`
	Language   string       `json:"language"`
	Version    int          `json:"version"`
	Round      int          `json:"round"`
	Turn       int          `json:"turn"`
	Players    []gamePlayer `json:"players"`
	Candidates []string     `json:"candidates"`
	Tie        bool         `json:"tie"`
	Result     string       `json:"result"`
	Die        int          `json:"die"`
	Uno        *unoState    `json:"uno,omitempty"`
}
type gameCommand struct {
	GameID      string `json:"game_id"`
	Round       int    `json:"round"`
	Phase       string `json:"phase"`
	Tie         bool   `json:"tie"`
	Action      string `json:"action"`
	Version     int    `json:"version"`
	Kind        string `json:"kind"`
	Language    string `json:"language"`
	Target      string `json:"target"`
	Guess       int    `json:"guess"`
	PlayerCount int    `json:"player_count"`
	CardID      *int   `json:"card_id"`
	Color       string `json:"color"`
	Uno         bool   `json:"uno"`
}

func randomNumber(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err)
	}
	return int(v.Int64())
}

var (
	errGameAmbiguous = errors.New("game ambiguous")
	errGameConflict  = errors.New("game version conflict")
)

type storedGame struct {
	ID        string
	Kind      string
	Game      *gameState
	CreatedAt int64
	UpdatedAt int64
}

type gameSummary struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Phase       string `json:"phase"`
	Language    string `json:"language"`
	Version     int    `json:"version"`
	Round       int    `json:"round"`
	Seats       int    `json:"seats"`
	PlayerCount int    `json:"player_count"`
	Seated      bool   `json:"seated"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

func (s *Server) readGames(room, kind string) ([]storedGame, error) {
	query := "SELECT game_id,kind,state,created_at,updated_at FROM games WHERE room_id=?"
	args := []interface{}{room}
	if kind != "" {
		query += " AND kind=?"
		args = append(args, kind)
	}
	rows, err := s.db.Query(query+" ORDER BY updated_at DESC,game_id ASC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	games := []storedGame{}
	for rows.Next() {
		var record storedGame
		var raw string
		if err = rows.Scan(&record.ID, &record.Kind, &raw, &record.CreatedAt, &record.UpdatedAt); err != nil {
			return nil, err
		}
		record.Game = &gameState{}
		if err = json.Unmarshal([]byte(raw), record.Game); err != nil {
			return nil, err
		}
		games = append(games, record)
	}
	return games, rows.Err()
}

func (s *Server) legacyGame(room string) (*storedGame, error) {
	games, err := s.readGames(room, "")
	if err != nil {
		return nil, err
	}
	if len(games) == 0 {
		return nil, nil
	}
	active := -1
	activeCount := 0
	for i := range games {
		if games[i].Game.Phase != "finished" {
			active = i
			activeCount++
		}
	}
	if activeCount == 1 {
		return &games[active], nil
	}
	if activeCount == 0 && len(games) == 1 {
		return &games[0], nil
	}
	return nil, errGameAmbiguous
}

func (s *Server) updateGame(room, id string, g *gameState, previousVersion int) error {
	raw, err := json.Marshal(g)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	result, err := s.db.Exec(`UPDATE games SET state=?,updated_at=?,human_joined_at=CASE
		WHEN human_joined_at=0 AND kind='uno' AND EXISTS (
			SELECT 1 FROM json_each(json_extract(?,'$.players')) AS player
			WHERE COALESCE(json_extract(player.value,'$.ai'),0)=0
		) THEN ? ELSE human_joined_at END
		WHERE room_id=? AND game_id=? AND json_extract(state,'$.version')=?`, string(raw), now, string(raw), now, room, id, previousVersion)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errGameConflict
	}
	return nil
}

func (s *Server) loadGame(room, id string) (*gameState, error) {
	var raw string
	err := s.db.QueryRow("SELECT state FROM games WHERE room_id=? AND game_id=?", room, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var g gameState
	err = json.Unmarshal([]byte(raw), &g)
	if err == nil && g.Phase != "finished" {
		changed := false
		kept := []gamePlayer{}
		for _, player := range g.Players {
			if player.AI {
				kept = append(kept, player)
				continue
			}
			var revoked int
			if e := s.db.QueryRow("SELECT revoked FROM participants WHERE id=?", player.ID).Scan(&revoked); e == nil && revoked != 0 {
				changed = true
				continue
			}
			kept = append(kept, player)
		}
		if changed {
			previousVersion := g.Version
			if g.Phase == "lobby" {
				g.Players = kept
			} else {
				g.Phase = "finished"
				g.Result = "cancelled"
				for i := range g.Players {
					g.Players[i].Word = ""
					g.Players[i].Spy = false
				}
			}
			g.Version++
			if e := s.updateGame(room, id, &g, previousVersion); e != nil {
				return nil, e
			}
			s.hub.notify(room)
		}
	}
	return &g, err
}

func (s *Server) gameFailure(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errGameAmbiguous) {
		apiError(w, 409, "GAME_AMBIGUOUS")
	} else if errors.Is(err, errGameConflict) {
		apiError(w, 409, "VERSION_CONFLICT")
	} else {
		s.internal(w, err)
	}
	return true
}
func gameView(g *gameState, p *principal) interface{} {
	if g == nil {
		return nil
	}
	if g.Kind == "uno" {
		return makeUnoView(g, p)
	}
	// Construct a public DTO explicitly: do not marshal private state then hide it in the UI.
	players := []map[string]interface{}{}
	var mine interface{}
	for _, v := range g.Players {
		row := map[string]interface{}{"id": v.ID, "name": v.Name, "alive": v.Alive, "score": v.Score, "submitted": v.Vote != "" || v.Guess > 0}
		if g.Phase == "finished" && g.Kind == "undercover" {
			row["word"] = v.Word
			row["spy"] = v.Spy
		}
		if g.Phase == "result" && g.Kind == "dice" {
			row["guess"] = v.Guess
		}
		if v.ID == p.ID && p.Role != "display" {
			mine = map[string]interface{}{"word": v.Word, "guess": v.Guess, "vote": v.Vote}
		}
		players = append(players, row)
	}
	return map[string]interface{}{"id": g.ID, "kind": g.Kind, "phase": g.Phase, "language": g.Language, "version": g.Version, "round": g.Round, "turn": g.Turn, "players": players, "candidates": g.Candidates, "tie": g.Tie, "result": g.Result, "die": g.Die, "mine": mine}
}
func (s *Server) gameList(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	records, err := s.readGames(room.ID, r.URL.Query().Get("kind"))
	if s.gameFailure(w, err) {
		return
	}
	summaries := make([]gameSummary, 0, len(records))
	for _, record := range records {
		summary := gameSummary{
			ID:        record.ID,
			Kind:      record.Kind,
			Phase:     record.Game.Phase,
			Language:  record.Game.Language,
			Version:   record.Game.Version,
			Round:     record.Game.Round,
			Seats:     len(record.Game.Players),
			CreatedAt: record.CreatedAt,
			UpdatedAt: record.UpdatedAt,
		}
		if record.Kind == "uno" && record.Game.Uno != nil {
			summary.PlayerCount = record.Game.Uno.PlayerCount
		}
		for _, player := range record.Game.Players {
			if player.ID == p.ID {
				summary.Seated = true
				break
			}
		}
		summaries = append(summaries, summary)
	}
	writeJSON(w, 200, map[string]interface{}{"games": summaries})
}

func (s *Server) gameSnapshot(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.legacyGame(room.ID)
	if s.gameFailure(w, err) {
		return
	}
	if record == nil {
		writeJSON(w, 200, nil)
		return
	}
	g, err := s.loadGame(room.ID, record.ID)
	if s.gameFailure(w, err) {
		return
	}
	writeJSON(w, 200, gameView(g, p))
}

func (s *Server) gameInstanceSnapshot(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := s.loadGame(room.ID, r.PathValue("game"))
	if s.gameFailure(w, err) {
		return
	}
	writeJSON(w, 200, gameView(g, p))
}

func (s *Server) gameAction(w http.ResponseWriter, r *http.Request) {
	s.performGameAction(w, r, "", true, false)
}

func (s *Server) gameCreate(w http.ResponseWriter, r *http.Request) {
	s.performGameAction(w, r, "", false, true)
}

func (s *Server) gameInstanceAction(w http.ResponseWriter, r *http.Request) {
	s.performGameAction(w, r, r.PathValue("game"), false, false)
}

func (s *Server) performGameAction(w http.ResponseWriter, r *http.Request, pathGameID string, legacy, createOnly bool) {
	p, _ := s.roomAccess(w, r)
	if p == nil {
		return
	}
	if p.Role == "display" {
		apiError(w, 403, "FORBIDDEN")
		return
	}
	var in gameCommand
	if !readJSON(w, r, &in) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room, err := s.getRoom(r.PathValue("room"))
	if err != nil {
		s.internal(w, err)
		return
	}
	// Revalidate membership after acquiring the mutation lock.
	p = s.identity(r, p.Role)
	if p == nil {
		apiError(w, 403, "FORBIDDEN")
		return
	}
	if !room.Active() {
		apiError(w, 409, "ROOM_CLOSED")
		return
	}
	if p.Role == "guest" {
		var muted bool
		if s.db.QueryRow("SELECT muted FROM participants WHERE id=?", p.ID).Scan(&muted) != nil || muted {
			apiError(w, 403, "FORBIDDEN")
			return
		}
	}
	if in.Action == "create" {
		if !legacy && !createOnly {
			apiError(w, 400, "INVALID_INPUT")
			return
		}
		if !s.permitted(p, room.ID, "games") {
			apiError(w, 403, "FORBIDDEN")
			return
		}
		if legacy {
			records, readErr := s.readGames(room.ID, "")
			if s.gameFailure(w, readErr) {
				return
			}
			for _, record := range records {
				if record.Game.Phase != "finished" {
					apiError(w, 409, "UPGRADE_REQUIRED")
					return
				}
			}
		}
		if (in.Kind != "undercover" && in.Kind != "dice" && in.Kind != "uno") || (in.Language != "zh" && in.Language != "en") {
			apiError(w, 400, "INVALID_INPUT")
			return
		}
		playerCount := in.PlayerCount
		if in.Kind == "uno" {
			if playerCount == 0 {
				playerCount = 4
			}
			if playerCount < 2 || playerCount > 8 {
				apiError(w, 400, "INVALID_INPUT")
				return
			}
		}
		g := &gameState{ID: randomID(16), Kind: in.Kind, Language: in.Language, Phase: "lobby", Version: 1, Players: []gamePlayer{}, Candidates: []string{}}
		if in.Kind == "uno" {
			g.Uno = &unoState{PlayerCount: playerCount, Direction: 1, Log: []string{}}
		}
		raw, marshalErr := json.Marshal(g)
		if marshalErr != nil {
			s.internal(w, marshalErr)
			return
		}
		now := time.Now().Unix()
		_, err = s.db.Exec("INSERT INTO games(room_id,game_id,kind,state,created_at,updated_at) VALUES(?,?,?,?,?,?)", room.ID, g.ID, g.Kind, string(raw), now, now)
		if err != nil {
			s.internal(w, err)
			return
		}
		s.hub.notify(room.ID)
		writeJSON(w, 200, gameView(g, p))
		return
	}
	if createOnly {
		apiError(w, 400, "INVALID_INPUT")
		return
	}

	targetID := pathGameID
	if legacy {
		targetID = in.GameID
		if targetID == "" {
			record, legacyErr := s.legacyGame(room.ID)
			if s.gameFailure(w, legacyErr) {
				return
			}
			if record != nil {
				targetID = record.ID
			}
		}
	} else if pathGameID == "" || in.GameID != pathGameID {
		apiError(w, 409, "VERSION_CONFLICT")
		return
	}
	g, err := s.loadGame(room.ID, targetID)
	if s.gameFailure(w, err) {
		return
	}
	if g == nil {
		apiError(w, 409, "GAME_MISSING")
		return
	}
	version := g.Version
	unoWrite := g.Kind == "uno"
	concurrent := !unoWrite && in.GameID == g.ID && in.Phase == g.Phase && in.Round == g.Round && in.Tie == g.Tie && (in.Action == "join" || in.Action == "leave" || in.Action == "guess" || in.Action == "vote")
	if in.Version != version && !concurrent {
		apiError(w, 409, "VERSION_CONFLICT")
		return
	}
	if unoWrite && isUnoTurnAction(in.Action) && (in.GameID != g.ID || in.Phase != g.Phase || in.Round != g.Round) {
		apiError(w, 409, "VERSION_CONFLICT")
		return
	}
	actor := *p
	if s.permitted(p, room.ID, "games") {
		actor.Role = "host"
	}
	if code := g.apply(in, &actor); code != "" {
		apiError(w, 409, code)
		return
	}
	g.Version = version + 1
	if err = s.updateGame(room.ID, targetID, g, version); s.gameFailure(w, err) {
		return
	}
	s.hub.notify(room.ID)
	writeJSON(w, 200, gameView(g, p))
}
func (g *gameState) apply(in gameCommand, p *principal) string {
	if g.Kind == "uno" {
		return g.applyUno(in, p)
	}
	index := -1
	for i, v := range g.Players {
		if v.ID == p.ID {
			index = i
		}
	}
	switch in.Action {
	case "join":
		if g.Phase != "lobby" {
			return "GAME_PHASE"
		}
		if index >= 0 {
			return "GAME_PHASE"
		}
		if len(g.Players) >= 12 {
			return "GAME_FULL"
		}
		g.Players = append(g.Players, gamePlayer{ID: p.ID, Name: p.Name, Alive: true})
	case "leave":
		if g.Phase != "lobby" || index < 0 {
			return "GAME_PHASE"
		}
		g.Players = append(g.Players[:index], g.Players[index+1:]...)
	case "cancel":
		if p.Role != "host" {
			return "FORBIDDEN"
		}
		g.Phase = "finished"
		g.Result = "cancelled"
		for i := range g.Players {
			g.Players[i].Word = ""
			g.Players[i].Spy = false
		}
	case "start":
		if p.Role != "host" {
			return "FORBIDDEN"
		}
		if g.Phase != "lobby" {
			return "GAME_PHASE"
		}
		minimum := 2
		if g.Kind == "undercover" {
			minimum = 4
		}
		if len(g.Players) < minimum {
			return "GAME_PLAYERS"
		}
		g.Round = 1
		g.Turn = 0
		if g.Kind == "dice" {
			g.Phase = "guess"
		} else {
			zh := [][2]string{{"咖啡", "奶茶"}, {"地铁", "高铁"}, {"月亮", "太阳"}, {"饺子", "馄饨"}, {"蛋糕", "面包"}, {"海豚", "鲸鱼"}, {"钢琴", "吉他"}, {"雨衣", "雨伞"}, {"西瓜", "哈密瓜"}, {"电影", "电视剧"}, {"冰箱", "空调"}, {"滑雪", "滑冰"}}
			en := [][2]string{{"Coffee", "Tea"}, {"Train", "Subway"}, {"Moon", "Sun"}, {"Cake", "Bread"}, {"Dolphin", "Whale"}, {"Piano", "Guitar"}, {"Raincoat", "Umbrella"}, {"Movie", "TV series"}, {"Skiing", "Ice skating"}, {"Beach", "Desert"}, {"Library", "Bookshop"}, {"Butterfly", "Dragonfly"}}
			pairs := zh
			if g.Language == "en" {
				pairs = en
			}
			pair := pairs[randomNumber(len(pairs))]
			spy := randomNumber(len(g.Players))
			for i := range g.Players {
				g.Players[i].Word = pair[0]
				g.Players[i].Spy = i == spy
				if i == spy {
					g.Players[i].Word = pair[1]
				}
			}
			g.Phase = "describe"
		}
	case "next":
		if g.Phase != "describe" || (p.Role != "host" && (index != g.Turn || index < 0)) {
			return "GAME_PHASE"
		}
		next := g.Turn + 1
		for next < len(g.Players) && !g.Players[next].Alive {
			next++
		}
		if next == len(g.Players) {
			g.Phase = "vote"
		} else {
			g.Turn = next
		}
	case "vote":
		if g.Phase != "vote" || index < 0 || !g.Players[index].Alive || g.Players[index].Vote != "" {
			return "GAME_PHASE"
		}
		valid := false
		for _, v := range g.Players {
			if v.ID == in.Target && v.Alive && v.ID != p.ID {
				valid = true
			}
		}
		if len(g.Candidates) > 0 {
			eligible := false
			for _, id := range g.Candidates {
				if id == in.Target {
					eligible = true
				}
			}
			valid = valid && eligible
		}
		if !valid {
			return "INVALID_INPUT"
		}
		g.Players[index].Vote = in.Target
		complete := true
		for _, v := range g.Players {
			if v.Alive && v.Vote == "" {
				complete = false
			}
		}
		if complete {
			g.resolveVote()
		}
	case "guess":
		if g.Kind != "dice" || g.Phase != "guess" || index < 0 || g.Players[index].Guess != 0 {
			return "GAME_PHASE"
		}
		if in.Guess < 1 || in.Guess > 6 {
			return "INVALID_INPUT"
		}
		g.Players[index].Guess = in.Guess
		complete := true
		for _, v := range g.Players {
			if v.Guess == 0 {
				complete = false
			}
		}
		if complete {
			g.Die = randomNumber(6) + 1
			g.Phase = "result"
			for i := range g.Players {
				if g.Players[i].Guess == g.Die {
					g.Players[i].Score++
				}
			}
		}
	case "round":
		if p.Role != "host" {
			return "FORBIDDEN"
		}
		if g.Kind != "dice" || g.Phase != "result" {
			return "GAME_PHASE"
		}
		g.Round++
		g.Die = 0
		g.Phase = "guess"
		for i := range g.Players {
			g.Players[i].Guess = 0
		}
	default:
		return "INVALID_INPUT"
	}
	return ""
}
func (g *gameState) resolveVote() {
	counts := map[string]int{}
	for _, v := range g.Players {
		if v.Alive {
			counts[v.Vote]++
		}
	}
	maximum := 0
	ties := []string{}
	for _, v := range g.Players {
		n := counts[v.ID]
		if n > maximum {
			maximum = n
			ties = []string{v.ID}
		} else if n == maximum && n > 0 {
			ties = append(ties, v.ID)
		}
	}
	for i := range g.Players {
		g.Players[i].Vote = ""
	}
	if len(ties) > 1 && !g.Tie {
		g.Tie = true
		g.Candidates = ties
		return
	}
	g.Candidates = []string{}
	g.Tie = false
	if len(ties) == 1 {
		for i := range g.Players {
			if g.Players[i].ID == ties[0] {
				g.Players[i].Alive = false
			}
		}
	}
	spies, civilians := 0, 0
	for _, v := range g.Players {
		if v.Alive {
			if v.Spy {
				spies++
			} else {
				civilians++
			}
		}
	}
	if spies == 0 {
		g.Phase = "finished"
		g.Result = "civilians"
	} else if spies >= civilians {
		g.Phase = "finished"
		g.Result = "spy"
	} else {
		g.Round++
		g.Phase = "describe"
		g.Turn = 0
		for !g.Players[g.Turn].Alive {
			g.Turn++
		}
	}
}
