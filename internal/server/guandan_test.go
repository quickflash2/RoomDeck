package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type guandanTestNative struct {
	sync.RWMutex
	rooms  []guandanNativeSummary
	closed []string
}

func newGuanDanTestNative(t *testing.T) (*guandanTestNative, *httptest.Server) {
	t.Helper()
	native := &guandanTestNative{rooms: []guandanNativeSummary{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/internal/roomdeck/rooms/") && strings.HasSuffix(r.URL.Path, "/close") {
			roomID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/roomdeck/rooms/"), "/close")
			if roomID == "" || strings.Contains(roomID, "/") {
				http.NotFound(w, r)
				return
			}
			native.Lock()
			native.closed = append(native.closed, roomID)
			native.Unlock()
			writeJSON(w, 200, map[string]bool{"closed": true})
			return
		}
		if r.URL.Path != "/internal/roomdeck/rooms" {
			t.Errorf("unexpected native summary path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		native.RLock()
		rooms := append([]guandanNativeSummary{}, native.rooms...)
		native.RUnlock()
		writeJSON(w, 200, map[string]interface{}{"rooms": rooms})
	}))
	t.Cleanup(upstream.Close)
	return native, upstream
}

func (n *guandanTestNative) set(rooms ...guandanNativeSummary) {
	n.Lock()
	n.rooms = rooms
	n.Unlock()
}

func (n *guandanTestNative) closedRooms() []string {
	n.RLock()
	defer n.RUnlock()
	return append([]string{}, n.closed...)
}

func createGuanDanTable(t *testing.T, f *fixture, c *http.Client) guandanGameSummary {
	t.Helper()
	var summary guandanGameSummary
	f.request(t, c, "POST", f.path("/guandan-games"), map[string]interface{}{}, 201, &summary)
	return summary
}

func guandanTableToken(t *testing.T, f *fixture, c *http.Client, roomID, gameID string) string {
	t.Helper()
	var launch struct{ Token string }
	f.request(t, c, "POST", "/rooms/"+roomID+"/guandan-games/"+gameID+"/session", map[string]interface{}{}, 201, &launch)
	return launch.Token
}

func exchangeGuanDanToken(t *testing.T, f *fixture, token string) (string, bool) {
	t.Helper()
	var exchanged struct {
		RoomID  string `json:"roomId"`
		Managed bool   `json:"managed"`
	}
	f.request(t, f.other, "POST", "/internal/guandan-exchange", map[string]string{"token": token}, 200, &exchanged)
	return exchanged.RoomID, exchanged.Managed
}

func guandanNativeID(t *testing.T, f *fixture, roomID, gameID string) string {
	t.Helper()
	var nativeRoomID string
	if err := f.s.db.QueryRow("SELECT native_room_id FROM guandan_games WHERE room_id=? AND game_id=?", roomID, gameID).Scan(&nativeRoomID); err != nil {
		t.Fatal(err)
	}
	return nativeRoomID
}

func TestGuanDanMultiTableSummariesAndExchangeIsolation(t *testing.T) {
	f := newFixture(t)
	native, upstream := newGuanDanTestNative(t)
	f.s.config.GuanDanURL = upstream.URL
	first := createGuanDanTable(t, f, f.host)
	second := createGuanDanTable(t, f, f.host)
	if first.ID == second.ID {
		t.Fatal("two tables received the same game ID")
	}
	for _, summary := range []guandanGameSummary{first, second} {
		if summary.PlayerCount != 0 || summary.MaxPlayers != 4 || summary.InGame || summary.GameMode != "Normal" || summary.HostName != "host" || !summary.Available || summary.ClosedAt != nil {
			t.Fatalf("unsafe new-table fallback: %+v", summary)
		}
		nativeID := guandanNativeID(t, f, f.room.ID, summary.ID)
		if !strings.HasPrefix(nativeID, guandanManagedRoomPrefix) || len(nativeID) > 40 {
			t.Fatalf("invalid managed native room ID %q", nativeID)
		}
	}
	firstNative := guandanNativeID(t, f, f.room.ID, first.ID)
	secondNative := guandanNativeID(t, f, f.room.ID, second.ID)
	if firstNative == secondNative {
		t.Fatal("two tables received the same native room ID")
	}
	native.set(
		guandanNativeSummary{ID: firstNative, PlayerCount: 2, MaxPlayers: 4, InGame: true, GameMode: "Skill", HostName: "First host", Managed: true},
		guandanNativeSummary{ID: secondNative, PlayerCount: 1, MaxPlayers: 4, GameMode: "Normal", HostName: "Second host", Managed: true},
	)
	var listed struct {
		Games []guandanGameSummary `json:"games"`
	}
	f.request(t, f.guest, "GET", f.path("/guandan-games"), nil, 200, &listed)
	if len(listed.Games) != 2 {
		t.Fatalf("listed %d tables, want 2", len(listed.Games))
	}
	byID := map[string]guandanGameSummary{}
	for _, summary := range listed.Games {
		byID[summary.ID] = summary
		if !summary.Available || summary.ClosedAt != nil || summary.LastSeenAt == 0 {
			t.Fatalf("native summary was not merged: %+v", summary)
		}
	}
	if byID[first.ID].PlayerCount != 2 || !byID[first.ID].InGame || byID[first.ID].GameMode != "Skill" || byID[first.ID].HostName != "First host" {
		t.Fatalf("first table received the wrong native summary: %+v", byID[first.ID])
	}
	if byID[second.ID].PlayerCount != 1 || byID[second.ID].InGame || byID[second.ID].HostName != "Second host" {
		t.Fatalf("second table received the wrong native summary: %+v", byID[second.ID])
	}

	firstToken := guandanTableToken(t, f, f.guest, f.room.ID, first.ID)
	secondToken := guandanTableToken(t, f, f.guest, f.room.ID, second.ID)
	if roomID, managed := exchangeGuanDanToken(t, f, firstToken); roomID != firstNative || !managed {
		t.Fatalf("first exchange crossed tables: room=%q managed=%v", roomID, managed)
	}
	if roomID, managed := exchangeGuanDanToken(t, f, secondToken); roomID != secondNative || !managed {
		t.Fatalf("second exchange crossed tables: room=%q managed=%v", roomID, managed)
	}

	var otherRoom Room
	f.request(t, f.host, "POST", "/rooms", map[string]interface{}{"name": "Other", "duration": 7200, "retention": 86400}, 201, &otherRoom)
	f.request(t, f.host, "POST", "/rooms/"+otherRoom.ID+"/guandan-games/"+first.ID+"/session", map[string]interface{}{}, 404, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games/not-a-game/session"), map[string]interface{}{}, 404, nil)
	if _, err := f.s.db.Exec("UPDATE guandan_games SET closed_at=1 WHERE room_id=? AND game_id=?", f.room.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.other, "POST", "/internal/guandan-exchange", map[string]string{"token": firstToken}, 409, nil)
}

func TestGuanDanSummaryAvailabilityFallbackPreservesRegistrations(t *testing.T) {
	f := newFixture(t)
	native, upstream := newGuanDanTestNative(t)
	f.s.config.GuanDanURL = upstream.URL
	created := createGuanDanTable(t, f, f.host)
	nativeID := guandanNativeID(t, f, f.room.ID, created.ID)

	read := func() guandanGameSummary {
		t.Helper()
		var listed struct {
			Games []guandanGameSummary `json:"games"`
		}
		f.request(t, f.guest, "GET", f.path("/guandan-games"), nil, 200, &listed)
		if len(listed.Games) != 1 {
			t.Fatalf("registration was removed: %+v", listed.Games)
		}
		return listed.Games[0]
	}
	missing := read()
	if !missing.Available || missing.PlayerCount != 0 || missing.LastSeenAt != 0 || missing.HostName != "host" {
		t.Fatalf("missing native room should use an available fallback: %+v", missing)
	}
	native.set(guandanNativeSummary{ID: nativeID, PlayerCount: 3, MaxPlayers: 4, InGame: true, GameMode: "Skill", HostName: "Live host", Managed: true})
	live := read()
	if live.PlayerCount != 3 || !live.InGame || live.LastSeenAt == 0 {
		t.Fatalf("live native summary missing: %+v", live)
	}
	upstream.Close()
	offline := read()
	if offline.Available || offline.PlayerCount != 0 || offline.MaxPlayers != 4 || offline.InGame || offline.GameMode != "Normal" || offline.HostName != "host" || offline.LastSeenAt != live.LastSeenAt || offline.ClosedAt != nil {
		t.Fatalf("offline fallback is stale or unsafe: %+v", offline)
	}
	f.request(t, f.host, "POST", f.path("/guandan-games/"+created.ID+"/close"), map[string]interface{}{}, 503, nil)
	var count, closedAt int
	if err := f.s.db.QueryRow("SELECT COUNT(*),closed_at FROM guandan_games WHERE room_id=? AND game_id=?", f.room.ID, created.ID).Scan(&count, &closedAt); err != nil {
		t.Fatal(err)
	}
	if count != 1 || closedAt != 0 {
		t.Fatalf("outage changed registration state: count=%d closed_at=%d", count, closedAt)
	}
}

func TestGuanDanTablePermissions(t *testing.T) {
	f := newFixture(t)
	_, upstream := newGuanDanTestNative(t)
	f.s.config.GuanDanURL = upstream.URL
	created := createGuanDanTable(t, f, f.host)
	f.request(t, f.guest, "POST", f.path("/guandan-games"), map[string]interface{}{}, 403, nil)
	_ = guandanTableToken(t, f, f.guest, f.room.ID, created.ID)

	var pair map[string]string
	f.request(t, f.host, "POST", f.path("/display-session"), nil, 201, &pair)
	display := client()
	f.request(t, display, "POST", "/display-exchange", pair, 200, nil)
	f.request(t, display, "POST", f.path("/guandan-games/"+created.ID+"/session"), map[string]interface{}{}, 403, nil)
	f.request(t, display, "POST", f.path("/guandan-games"), map[string]interface{}{}, 403, nil)
	f.request(t, display, "GET", f.path("/guandan-games?display=1"), nil, 200, nil)

	manager := client()
	f.request(t, manager, "POST", "/join", joinInput{Code: f.room.Code, Name: "Table manager"}, 201, nil)
	if _, err := f.s.db.Exec("UPDATE participants SET permissions='[\"games\"]' WHERE room_id=? AND name=?", f.room.ID, "Table manager"); err != nil {
		t.Fatal(err)
	}
	_ = createGuanDanTable(t, f, manager)

	if _, err := f.s.db.Exec("UPDATE participants SET muted=1 WHERE room_id=? AND name=?", f.room.ID, "Guest 访客"); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.guest, "POST", f.path("/guandan-games/"+created.ID+"/session"), map[string]interface{}{}, 403, nil)
	if _, err := f.s.db.Exec("UPDATE participants SET muted=0,revoked=1 WHERE room_id=? AND name=?", f.room.ID, "Guest 访客"); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.guest, "POST", f.path("/guandan-games/"+created.ID+"/session"), map[string]interface{}{}, 401, nil)
	f.request(t, f.host, "POST", f.path("/close"), nil, 200, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games"), map[string]interface{}{}, 409, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games/"+created.ID+"/session"), map[string]interface{}{}, 409, nil)
}

func TestGuanDanHostCanCloseOneTable(t *testing.T) {
	f := newFixture(t)
	native, upstream := newGuanDanTestNative(t)
	f.s.config.GuanDanURL = upstream.URL
	first := createGuanDanTable(t, f, f.host)
	second := createGuanDanTable(t, f, f.host)
	firstNative := guandanNativeID(t, f, f.room.ID, first.ID)
	secondNative := guandanNativeID(t, f, f.room.ID, second.ID)
	token := guandanTableToken(t, f, f.guest, f.room.ID, first.ID)

	f.request(t, f.guest, "POST", f.path("/guandan-games/"+first.ID+"/close"), map[string]interface{}{}, 403, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games/missing/close"), map[string]interface{}{}, 404, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games/"+first.ID+"/close"), map[string]interface{}{}, 200, nil)
	f.request(t, f.host, "POST", f.path("/guandan-games/"+first.ID+"/close"), map[string]interface{}{}, 200, nil)
	closed := native.closedRooms()
	if len(closed) != 1 || closed[0] != firstNative {
		t.Fatalf("native close calls = %v, want only %q", closed, firstNative)
	}
	f.request(t, f.other, "POST", "/internal/guandan-exchange", map[string]string{"token": token}, 409, nil)
	f.request(t, f.guest, "POST", f.path("/guandan-games/"+first.ID+"/session"), map[string]interface{}{}, 409, nil)

	var listed struct {
		Games []guandanGameSummary `json:"games"`
	}
	f.request(t, f.guest, "GET", f.path("/guandan-games"), nil, 200, &listed)
	if len(listed.Games) != 2 {
		t.Fatalf("listed %d tables, want 2", len(listed.Games))
	}
	for _, summary := range listed.Games {
		switch summary.ID {
		case first.ID:
			if summary.ClosedAt == nil || summary.Available {
				t.Fatalf("first table was not closed: %+v", summary)
			}
		case second.ID:
			if summary.ClosedAt != nil || !summary.Available {
				t.Fatalf("closing first table affected second: %+v", summary)
			}
		}
	}
	closed = native.closedRooms()
	if len(closed) != 1 || closed[0] != firstNative || secondNative == firstNative {
		t.Fatalf("close crossed native tables: %v", closed)
	}
	var roomCount int
	if err := f.s.db.QueryRow("SELECT COUNT(*) FROM rooms WHERE id=? AND state='active'", f.room.ID).Scan(&roomCount); err != nil {
		t.Fatal(err)
	}
	if roomCount != 1 {
		t.Fatal("closing a table closed the outer RoomDeck room")
	}
}

func TestGuanDanLegacySessionRegistersOneManagedNativeTable(t *testing.T) {
	f := newFixture(t)
	f.s.config.GuanDanURL = "http://guandan.test"
	var hostLaunch, guestLaunch struct{ Token string }
	f.request(t, f.host, "POST", f.path("/guandan-session"), nil, 201, &hostLaunch)
	f.request(t, f.guest, "POST", f.path("/guandan-session"), nil, 201, &guestLaunch)
	var count int
	var gameID, createdBy string
	if err := f.s.db.QueryRow("SELECT COUNT(*),MIN(game_id),MIN(created_by) FROM guandan_games WHERE room_id=? AND native_room_id=?", f.room.ID, f.room.ID).Scan(&count, &gameID, &createdBy); err != nil {
		t.Fatal(err)
	}
	if count != 1 || gameID != "legacy" || createdBy != "host" {
		t.Fatalf("legacy registration is not idempotent: count=%d id=%q creator=%q", count, gameID, createdBy)
	}
	for _, token := range []string{hostLaunch.Token, guestLaunch.Token} {
		if roomID, managed := exchangeGuanDanToken(t, f, token); roomID != f.room.ID || !managed {
			t.Fatalf("legacy exchange changed its native room: room=%q managed=%v", roomID, managed)
		}
	}
}
