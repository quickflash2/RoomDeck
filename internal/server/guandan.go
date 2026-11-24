package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const guandanManagedRoomPrefix = "rd_"

type guandanSession struct {
	RoomID, GameID, PlayerID, Role, Name string
	Expires                            time.Time
}

type guandanGame struct {
	ID, NativeRoomID, CreatedBy string
	CreatedAt, LastSeenAt       int64
	ClosedAt                    int64
}

type guandanGameSummary struct {
	ID          string `json:"id"`
	PlayerCount int    `json:"player_count"`
	MaxPlayers  int    `json:"max_players"`
	InGame      bool   `json:"in_game"`
	GameMode    string `json:"game_mode"`
	HostName    string `json:"host_name"`
	Available   bool   `json:"available"`
	CreatedAt   int64  `json:"created_at"`
	LastSeenAt  int64  `json:"last_seen_at"`
	ClosedAt    *int64 `json:"closed_at"`
}

type guandanNativeSummary struct {
	ID          string `json:"id"`
	PlayerCount int    `json:"playerCount"`
	MaxPlayers  int    `json:"maxPlayers"`
	InGame      bool   `json:"inGame"`
	GameMode    string `json:"gameMode"`
	HostName    string `json:"hostName"`
	Managed     bool   `json:"managed"`
}

func (s *Server) guandanLaunchAllowed(w http.ResponseWriter, p *principal, room *Room) bool {
	if p.Role == "display" {
		apiError(w, 403, "FORBIDDEN")
		return false
	}
	if !room.Active() {
		apiError(w, 409, "ROOM_CLOSED")
		return false
	}
	if s.config.GuanDanURL == "" {
		apiError(w, 503, "GUANDAN_UNAVAILABLE")
		return false
	}
	if p.Role == "guest" {
		var revoked, muted bool
		if err := s.db.QueryRow("SELECT revoked,muted FROM participants WHERE id=? AND room_id=?", p.ID, room.ID).Scan(&revoked, &muted); err != nil || revoked || muted {
			apiError(w, 403, "FORBIDDEN")
			return false
		}
	}
	return true
}

func (s *Server) issueGuanDanSession(w http.ResponseWriter, p *principal, roomID, gameID string) {
	token := randomID(24)
	now := time.Now()
	s.guandanMu.Lock()
	for key, session := range s.guandan {
		if now.After(session.Expires) {
			delete(s.guandan, key)
		}
	}
	s.guandan[digest(token)] = guandanSession{RoomID: roomID, GameID: gameID, PlayerID: p.ID, Role: p.Role, Name: p.Name, Expires: now.Add(24 * time.Hour)}
	s.guandanMu.Unlock()
	writeJSON(w, 201, map[string]string{"token": token})
}

func (s *Server) registerLegacyGuanDanGame(p *principal, room *Room) (string, int64, error) {
	now := time.Now().Unix()
	_, err := s.db.Exec(`INSERT INTO guandan_games(room_id,game_id,native_room_id,created_by,created_at)
		VALUES(?,?,?,?,?) ON CONFLICT(native_room_id) DO NOTHING`, room.ID, "legacy", room.ID, p.Name, now)
	if err != nil {
		return "", 0, err
	}
	var gameID string
	var closedAt int64
	err = s.db.QueryRow("SELECT game_id,closed_at FROM guandan_games WHERE room_id=? AND native_room_id=?", room.ID, room.ID).Scan(&gameID, &closedAt)
	return gameID, closedAt, err
}

// guandanSession retains the original single-table launch URL. Its native room
// is registered lazily so old links and new multi-table launches share checks.
func (s *Server) guandanSession(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil || !s.guandanLaunchAllowed(w, p, room) {
		return
	}
	gameID, closedAt, err := s.registerLegacyGuanDanGame(p, room)
	if err != nil {
		s.internal(w, err)
		return
	}
	if closedAt != 0 {
		apiError(w, 409, "GUANDAN_GAME_CLOSED")
		return
	}
	s.issueGuanDanSession(w, p, room.ID, gameID)
}

func (s *Server) guandanGameCreate(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	var in struct{}
	if !readJSON(w, r, &in) {
		return
	}
	if !room.Active() {
		apiError(w, 409, "ROOM_CLOSED")
		return
	}
	if !s.permitted(p, room.ID, "games") {
		apiError(w, 403, "FORBIDDEN")
		return
	}
	if !s.guandanLaunchAllowed(w, p, room) {
		return
	}
	gameID := randomID(16)
	nativeRoomID := guandanManagedRoomPrefix + randomID(16)
	_, err := s.db.Exec("INSERT INTO guandan_games(room_id,game_id,native_room_id,created_by,created_at) VALUES(?,?,?,?,?)", room.ID, gameID, nativeRoomID, p.Name, time.Now().Unix())
	if err != nil {
		s.internal(w, err)
		return
	}
	summaries, err := s.guandanGameSummaries(room.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	for _, summary := range summaries {
		if summary.ID == gameID {
			writeJSON(w, 201, summary)
			return
		}
	}
	s.internal(w, sql.ErrNoRows)
}

func (s *Server) guandanGameSession(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	var in struct{}
	if !readJSON(w, r, &in) {
		return
	}
	if !s.guandanLaunchAllowed(w, p, room) {
		return
	}
	var closedAt int64
	err := s.db.QueryRow("SELECT closed_at FROM guandan_games WHERE room_id=? AND game_id=?", room.ID, r.PathValue("gameId")).Scan(&closedAt)
	if err == sql.ErrNoRows {
		apiError(w, 404, "GUANDAN_GAME_NOT_FOUND")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if closedAt != 0 {
		apiError(w, 409, "GUANDAN_GAME_CLOSED")
		return
	}
	s.issueGuanDanSession(w, p, room.ID, r.PathValue("gameId"))
}

func (s *Server) guandanGameClose(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	if !room.Active() {
		apiError(w, 409, "ROOM_CLOSED")
		return
	}
	if !s.permitted(p, room.ID, "games") {
		apiError(w, 403, "FORBIDDEN")
		return
	}
	gameID := r.PathValue("gameId")
	var nativeRoomID string
	var closedAt int64
	err := s.db.QueryRow("SELECT native_room_id,closed_at FROM guandan_games WHERE room_id=? AND game_id=?", room.ID, gameID).Scan(&nativeRoomID, &closedAt)
	if err == sql.ErrNoRows {
		apiError(w, 404, "GUANDAN_GAME_NOT_FOUND")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if closedAt == 0 {
		if s.config.GuanDanURL == "" {
			apiError(w, 503, "GUANDAN_UNAVAILABLE")
			return
		}
		req, requestErr := http.NewRequestWithContext(r.Context(), http.MethodPost, s.config.GuanDanURL+"/internal/roomdeck/rooms/"+url.PathEscape(nativeRoomID)+"/close", nil)
		if requestErr != nil {
			s.internal(w, requestErr)
			return
		}
		client := &http.Client{Timeout: 1500 * time.Millisecond}
		res, requestErr := client.Do(req)
		if requestErr != nil {
			apiError(w, 503, "GUANDAN_UNAVAILABLE")
			return
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			apiError(w, 503, "GUANDAN_UNAVAILABLE")
			return
		}
		closedAt = time.Now().Unix()
		if _, err = s.db.Exec("UPDATE guandan_games SET closed_at=? WHERE room_id=? AND game_id=?", closedAt, room.ID, gameID); err != nil {
			s.internal(w, err)
			return
		}
		s.hub.notify(room.ID)
	}
	writeJSON(w, 200, map[string]interface{}{"id": gameID, "closed_at": closedAt})
}

func (s *Server) readGuanDanGames(roomID string) ([]guandanGame, error) {
	rows, err := s.db.Query("SELECT game_id,native_room_id,created_by,created_at,last_seen_at,closed_at FROM guandan_games WHERE room_id=? ORDER BY created_at ASC,game_id ASC", roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	games := []guandanGame{}
	for rows.Next() {
		var game guandanGame
		if err = rows.Scan(&game.ID, &game.NativeRoomID, &game.CreatedBy, &game.CreatedAt, &game.LastSeenAt, &game.ClosedAt); err != nil {
			return nil, err
		}
		games = append(games, game)
	}
	return games, rows.Err()
}

func (s *Server) nativeGuanDanSummaries() (map[string]guandanNativeSummary, bool) {
	if s.config.GuanDanURL == "" {
		return nil, false
	}
	req, err := http.NewRequestWithContext(s.ctx, http.MethodGet, s.config.GuanDanURL+"/internal/roomdeck/rooms", nil)
	if err != nil {
		return nil, false
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	res, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, false
	}
	const responseLimit = 256 << 10
	body, err := io.ReadAll(io.LimitReader(res.Body, responseLimit+1))
	if err != nil || len(body) > responseLimit {
		return nil, false
	}
	var payload struct {
		Rooms []guandanNativeSummary `json:"rooms"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&payload); err != nil || payload.Rooms == nil {
		return nil, false
	}
	var extra interface{}
	if err = decoder.Decode(&extra); err != io.EOF || len(payload.Rooms) > 4096 {
		return nil, false
	}
	result := make(map[string]guandanNativeSummary, len(payload.Rooms))
	for _, room := range payload.Rooms {
		if room.ID == "" || len(room.ID) > 40 || strings.TrimSpace(room.ID) != room.ID || room.PlayerCount < 0 || room.PlayerCount > 4 || room.MaxPlayers != 4 || (room.GameMode != "Normal" && room.GameMode != "Skill") || !utf8.ValidString(room.HostName) || utf8.RuneCountInString(room.HostName) > 40 {
			return nil, false
		}
		if _, duplicate := result[room.ID]; duplicate {
			return nil, false
		}
		result[room.ID] = room
	}
	return result, true
}

func (s *Server) guandanGameSummaries(roomID string) ([]guandanGameSummary, error) {
	games, err := s.readGuanDanGames(roomID)
	if err != nil {
		return nil, err
	}
	native, reachable := s.nativeGuanDanSummaries()
	now := time.Now().Unix()
	summaries := make([]guandanGameSummary, 0, len(games))
	seen := make([]string, 0, len(games))
	for _, game := range games {
		hostName := game.CreatedBy
		if hostName == "" {
			hostName = "未知"
		}
		summary := guandanGameSummary{
			ID: game.ID, MaxPlayers: 4, GameMode: "Normal", HostName: hostName,
			Available: reachable && game.ClosedAt == 0, CreatedAt: game.CreatedAt, LastSeenAt: game.LastSeenAt,
		}
		if game.ClosedAt != 0 {
			closedAt := game.ClosedAt
			summary.ClosedAt = &closedAt
		}
		if current, ok := native[game.NativeRoomID]; ok {
			summary.PlayerCount = current.PlayerCount
			summary.MaxPlayers = current.MaxPlayers
			summary.InGame = current.InGame
			summary.GameMode = current.GameMode
			if current.HostName != "" {
				summary.HostName = current.HostName
			}
			summary.LastSeenAt = now
			seen = append(seen, game.ID)
		}
		summaries = append(summaries, summary)
	}
	if len(seen) != 0 {
		tx, err := s.db.Begin()
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		for _, gameID := range seen {
			if _, err = tx.Exec("UPDATE guandan_games SET last_seen_at=? WHERE room_id=? AND game_id=?", now, roomID, gameID); err != nil {
				return nil, err
			}
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
	}
	return summaries, nil
}

func (s *Server) guandanGameList(w http.ResponseWriter, r *http.Request) {
	p, room := s.roomAccess(w, r)
	if p == nil {
		return
	}
	summaries, err := s.guandanGameSummaries(room.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, 200, map[string]interface{}{"games": summaries})
}

func (s *Server) guandanExchange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	key := digest(in.Token)
	s.guandanMu.Lock()
	session, ok := s.guandan[key]
	if ok && time.Now().After(session.Expires) {
		delete(s.guandan, key)
		ok = false
	}
	s.guandanMu.Unlock()
	if !ok {
		apiError(w, 403, "GUANDAN_SESSION_INVALID")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room, err := s.getRoom(session.RoomID)
	if err != nil || !room.Active() {
		apiError(w, 409, "ROOM_CLOSED")
		return
	}
	var nativeRoomID string
	var closedAt int64
	err = s.db.QueryRow("SELECT native_room_id,closed_at FROM guandan_games WHERE room_id=? AND game_id=?", session.RoomID, session.GameID).Scan(&nativeRoomID, &closedAt)
	if err == sql.ErrNoRows {
		apiError(w, 403, "GUANDAN_SESSION_INVALID")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if closedAt != 0 {
		apiError(w, 409, "GUANDAN_GAME_CLOSED")
		return
	}
	if session.Role == "guest" {
		var revoked, muted bool
		if err = s.db.QueryRow("SELECT revoked,muted FROM participants WHERE id=? AND room_id=?", session.PlayerID, session.RoomID).Scan(&revoked, &muted); err != nil || revoked || muted {
			apiError(w, 403, "GUANDAN_SESSION_INVALID")
			return
		}
	} else {
		var exists int
		if err = s.db.QueryRow("SELECT COUNT(*) FROM admins WHERE id=?", session.PlayerID).Scan(&exists); err != nil || exists != 1 || session.Role != "host" {
			apiError(w, 403, "GUANDAN_SESSION_INVALID")
			return
		}
	}
	_, err = s.db.Exec("UPDATE guandan_games SET human_joined_at=CASE WHEN human_joined_at=0 THEN ? ELSE human_joined_at END WHERE room_id=? AND game_id=? AND closed_at=0", time.Now().Unix(), session.RoomID, session.GameID)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, 200, map[string]interface{}{
		"roomId":     nativeRoomID,
		"playerName": session.Name,
		"playerKey":  digest(session.Role + ":" + session.PlayerID),
		"managed":    true,
	})
}

func (s *Server) guandanProxy(w http.ResponseWriter, r *http.Request) {
	if s.config.GuanDanURL == "" {
		apiError(w, 503, "GUANDAN_UNAVAILABLE")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/guandan/internal/") {
		apiError(w, 404, "NOT_FOUND")
		return
	}
	target, err := url.Parse(s.config.GuanDanURL)
	if err != nil {
		s.internal(w, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		if strings.HasPrefix(req.URL.Path, "/guandan/") {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/guandan")
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
		}
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		apiError(w, 503, "GUANDAN_UNAVAILABLE")
	}
	proxy.ServeHTTP(w, r)
}
