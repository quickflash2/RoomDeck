package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func createMultiTestGame(t *testing.T, f *fixture, c *http.Client, kind string, playerCount int) gameState {
	t.Helper()
	var g gameState
	f.request(t, c, "POST", f.path("/games"), gameCommand{Action: "create", Kind: kind, Language: "en", PlayerCount: playerCount}, 200, &g)
	if g.ID == "" || g.Kind != kind || g.Version != 1 {
		t.Fatalf("invalid created game: %+v", g)
	}
	return g
}

func multiTestCommand(g gameState, action string) gameCommand {
	return gameCommand{Action: action, GameID: g.ID, Version: g.Version, Round: g.Round, Phase: g.Phase, Tie: g.Tie}
}

func actMultiTestGame(t *testing.T, f *fixture, c *http.Client, g gameState, action string) gameState {
	t.Helper()
	var next gameState
	f.request(t, c, "POST", f.path("/games/"+g.ID), multiTestCommand(g, action), 200, &next)
	return next
}

func rawMultiTestGame(t *testing.T, db *sql.DB, room, id string) string {
	t.Helper()
	var raw string
	if err := db.QueryRow("SELECT state FROM games WHERE room_id=? AND game_id=?", room, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func requireMultiTestError(t *testing.T, raw []byte, want string) {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != want {
		t.Fatalf("error code = %q, want %q: %s", body.Error.Code, want, raw)
	}
}

func TestMultiGameCreationActionAndCancelIsolation(t *testing.T) {
	f := newFixture(t)
	first := createMultiTestGame(t, f, f.host, "uno", 4)
	second := createMultiTestGame(t, f, f.host, "uno", 2)
	undercover := createMultiTestGame(t, f, f.host, "undercover", 0)
	dice := createMultiTestGame(t, f, f.host, "dice", 0)
	ids := map[string]bool{first.ID: true, second.ID: true, undercover.ID: true, dice.ID: true}
	if len(ids) != 4 {
		t.Fatal("game IDs were not independent")
	}

	secondBefore := rawMultiTestGame(t, f.s.db, f.room.ID, second.ID)
	undercoverBefore := rawMultiTestGame(t, f.s.db, f.room.ID, undercover.ID)
	diceBefore := rawMultiTestGame(t, f.s.db, f.room.ID, dice.ID)
	joined := actMultiTestGame(t, f, f.host, first, "join")
	if joined.Version != first.Version+1 {
		t.Fatalf("join version = %d", joined.Version)
	}
	for id, before := range map[string]string{second.ID: secondBefore, undercover.ID: undercoverBefore, dice.ID: diceBefore} {
		if after := rawMultiTestGame(t, f.s.db, f.room.ID, id); after != before {
			t.Fatalf("join on %s changed %s", first.ID, id)
		}
	}

	var createdAt, updatedAt, humanJoinedAt int64
	if err := f.s.db.QueryRow("SELECT created_at,updated_at,human_joined_at FROM games WHERE room_id=? AND game_id=?", f.room.ID, first.ID).Scan(&createdAt, &updatedAt, &humanJoinedAt); err != nil {
		t.Fatal(err)
	}
	if humanJoinedAt == 0 {
		t.Fatal("UNO join did not record a human player")
	}
	if _, err := f.s.db.Exec("UPDATE games SET updated_at=? WHERE room_id=? AND game_id=?", updatedAt-20, f.room.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	cancelled := actMultiTestGame(t, f, f.host, joined, "cancel")
	if cancelled.Phase != "finished" || cancelled.Result != "cancelled" {
		t.Fatalf("cancel result: %+v", cancelled)
	}
	for id, before := range map[string]string{second.ID: secondBefore, undercover.ID: undercoverBefore, dice.ID: diceBefore} {
		if after := rawMultiTestGame(t, f.s.db, f.room.ID, id); after != before {
			t.Fatalf("cancel on %s changed %s", first.ID, id)
		}
	}
	var createdAfter, updatedAfter int64
	if err := f.s.db.QueryRow("SELECT created_at,updated_at FROM games WHERE room_id=? AND game_id=?", f.room.ID, first.ID).Scan(&createdAfter, &updatedAfter); err != nil {
		t.Fatal(err)
	}
	if createdAfter != createdAt || updatedAfter <= updatedAt-20 {
		t.Fatalf("timestamps changed incorrectly: created %d/%d updated %d/%d", createdAt, createdAfter, updatedAt, updatedAfter)
	}
}

func TestMultiGameListIsStablePrivateAndReadOnly(t *testing.T) {
	f := newFixture(t)
	f.request(t, f.other, "POST", "/join", joinInput{Code: f.room.Code, Name: "Spectator"}, 201, nil)
	first := createMultiTestGame(t, f, f.host, "uno", 4)
	second := createMultiTestGame(t, f, f.host, "uno", 2)
	dice := createMultiTestGame(t, f, f.host, "dice", 0)
	first = actMultiTestGame(t, f, f.host, first, "join")
	first = actMultiTestGame(t, f, f.guest, first, "join")
	first = actMultiTestGame(t, f, f.host, first, "start")
	before := map[string]string{
		first.ID:  rawMultiTestGame(t, f.s.db, f.room.ID, first.ID),
		second.ID: rawMultiTestGame(t, f.s.db, f.room.ID, second.ID),
		dice.ID:   rawMultiTestGame(t, f.s.db, f.room.ID, dice.ID),
	}
	if !strings.Contains(before[first.ID], `"hands"`) || !strings.Contains(before[first.ID], `"deck"`) {
		t.Fatal("test did not create private UNO state")
	}
	if _, err := f.s.db.Exec("UPDATE games SET updated_at=CASE game_id WHEN ? THEN 200 ELSE 100 END WHERE room_id=? AND kind='uno'", first.ID, f.room.ID); err != nil {
		t.Fatal(err)
	}

	readList := func(c *http.Client) ([]gameSummary, []byte) {
		raw := f.request(t, c, "GET", f.path("/games?kind=uno"), nil, 200, nil)
		var response struct {
			Games []gameSummary `json:"games"`
		}
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		return response.Games, raw
	}
	games, _ := readList(f.host)
	if len(games) != 2 || games[0].ID != first.ID || games[1].ID != second.ID {
		t.Fatalf("updated_at ordering is wrong: %+v", games)
	}
	if games[0].Seats != 4 || games[0].PlayerCount != 4 || !games[0].Seated {
		t.Fatalf("UNO summary is wrong: %+v", games[0])
	}
	if games[1].Seats != 0 || games[1].PlayerCount != 2 || games[1].Seated {
		t.Fatalf("second UNO summary is wrong: %+v", games[1])
	}

	if _, err := f.s.db.Exec("UPDATE games SET updated_at=100 WHERE room_id=? AND kind='uno'", f.room.ID); err != nil {
		t.Fatal(err)
	}
	games, raw := readList(f.host)
	wantOrder := []string{first.ID, second.ID}
	sort.Strings(wantOrder)
	if len(games) != 2 || games[0].ID != wantOrder[0] || games[1].ID != wantOrder[1] {
		t.Fatalf("ID tie-break ordering is wrong: %+v", games)
	}
	var object struct {
		Games []map[string]json.RawMessage `json:"games"`
	}
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"id": true, "kind": true, "phase": true, "language": true, "version": true, "round": true, "seats": true, "player_count": true, "seated": true, "created_at": true, "updated_at": true}
	for _, summary := range object.Games {
		if len(summary) != len(allowed) {
			t.Fatalf("summary fields are not exact: %s", raw)
		}
		for key := range summary {
			if !allowed[key] {
				t.Fatalf("summary leaked field %q: %s", key, raw)
			}
		}
	}
	guestGames, _ := readList(f.guest)
	if len(guestGames) != 2 {
		t.Fatal("guest list is incomplete")
	}
	for _, summary := range guestGames {
		if summary.Seated != (summary.ID == first.ID) {
			t.Fatalf("guest seated state is wrong: %+v", summary)
		}
	}
	otherGames, _ := readList(f.other)
	for _, summary := range otherGames {
		if summary.Seated {
			t.Fatal("spectator was marked seated")
		}
	}
	for id, state := range before {
		if after := rawMultiTestGame(t, f.s.db, f.room.ID, id); after != state {
			t.Fatalf("listing advanced or changed game %s", id)
		}
	}
}

func TestMultiGameRejectsWrongIdentityAndStaleVersion(t *testing.T) {
	f := newFixture(t)
	first := createMultiTestGame(t, f, f.host, "dice", 0)
	second := createMultiTestGame(t, f, f.host, "dice", 0)
	secondBefore := rawMultiTestGame(t, f.s.db, f.room.ID, second.ID)

	wrongBody := multiTestCommand(first, "cancel")
	wrongBody.GameID = second.ID
	raw := f.request(t, f.host, "POST", f.path("/games/"+first.ID), wrongBody, 409, nil)
	requireMultiTestError(t, raw, "VERSION_CONFLICT")
	if after := rawMultiTestGame(t, f.s.db, f.room.ID, second.ID); after != secondBefore {
		t.Fatal("mismatched body changed another instance")
	}

	var otherRoom Room
	f.request(t, f.host, "POST", "/rooms", map[string]interface{}{"name": "Other", "duration": 7200, "retention": 86400}, 201, &otherRoom)
	raw = f.request(t, f.host, "POST", "/rooms/"+otherRoom.ID+"/games/"+first.ID, multiTestCommand(first, "cancel"), 409, nil)
	requireMultiTestError(t, raw, "GAME_MISSING")

	oldVersion := first.Version
	joined := actMultiTestGame(t, f, f.host, first, "join")
	stale := multiTestCommand(joined, "cancel")
	stale.Version = oldVersion
	raw = f.request(t, f.host, "POST", f.path("/games/"+first.ID), stale, 409, nil)
	requireMultiTestError(t, raw, "VERSION_CONFLICT")
	var current gameState
	if err := json.Unmarshal([]byte(rawMultiTestGame(t, f.s.db, f.room.ID, first.ID)), &current); err != nil {
		t.Fatal(err)
	}
	if current.Phase != "lobby" || current.Version != joined.Version {
		t.Fatalf("stale action changed state: %+v", current)
	}
	if err := f.s.updateGame(f.room.ID, first.ID, &current, oldVersion); !errors.Is(err, errGameConflict) {
		t.Fatalf("conditional update error = %v", err)
	}
}

func TestLegacyGameCompatibilityAndAmbiguity(t *testing.T) {
	f := newFixture(t)
	if raw := f.request(t, f.host, "GET", f.path("/game"), nil, 200, nil); strings.TrimSpace(string(raw)) != "null" {
		t.Fatalf("empty legacy snapshot = %s", raw)
	}
	first := createMultiTestGame(t, f, f.host, "dice", 0)
	second := createMultiTestGame(t, f, f.host, "uno", 2)
	before := rawMultiTestGame(t, f.s.db, f.room.ID, second.ID)

	raw := f.request(t, f.host, "GET", f.path("/game"), nil, 409, nil)
	requireMultiTestError(t, raw, "GAME_AMBIGUOUS")
	raw = f.request(t, f.host, "POST", f.path("/game"), gameCommand{Action: "cancel", Version: first.Version}, 409, nil)
	requireMultiTestError(t, raw, "GAME_AMBIGUOUS")
	raw = f.request(t, f.host, "POST", f.path("/game"), gameCommand{Action: "create", Kind: "dice", Language: "en"}, 409, nil)
	requireMultiTestError(t, raw, "UPGRADE_REQUIRED")
	if after := rawMultiTestGame(t, f.s.db, f.room.ID, second.ID); after != before {
		t.Fatal("legacy rejection cancelled or changed a game")
	}

	var cancelled gameState
	f.request(t, f.host, "POST", f.path("/game"), multiTestCommand(first, "cancel"), 200, &cancelled)
	if cancelled.ID != first.ID || cancelled.Phase != "finished" {
		t.Fatalf("legacy accurate ID action failed: %+v", cancelled)
	}
	var selected gameState
	f.request(t, f.host, "GET", f.path("/game"), nil, 200, &selected)
	if selected.ID != second.ID {
		t.Fatalf("legacy unique active selection = %s, want %s", selected.ID, second.ID)
	}
	_ = actMultiTestGame(t, f, f.host, second, "cancel")
	raw = f.request(t, f.host, "GET", f.path("/game"), nil, 409, nil)
	requireMultiTestError(t, raw, "GAME_AMBIGUOUS")

	var replacement gameState
	f.request(t, f.host, "POST", f.path("/game"), gameCommand{Action: "create", Kind: "undercover", Language: "en"}, 200, &replacement)
	if replacement.ID == "" || replacement.ID == first.ID || replacement.ID == second.ID {
		t.Fatalf("legacy create did not make an independent instance: %+v", replacement)
	}
	f.request(t, f.host, "GET", f.path("/game"), nil, 200, &selected)
	if selected.ID != replacement.ID {
		t.Fatal("legacy snapshot did not select the sole active replacement")
	}
}

func prepareV7GameMigration(t *testing.T, raw string) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	s, err := New(Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	db, err := sql.Open("sqlite", filepath.Join(dir, "roomdeck.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(`PRAGMA foreign_keys=ON;
DROP TABLE guandan_games;
DROP TABLE games;
DROP INDEX rooms_owner;
ALTER TABLE rooms DROP COLUMN owner_id;
ALTER TABLE admins DROP COLUMN role;
CREATE TABLE games(room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,state TEXT NOT NULL);
PRAGMA user_version=7;
INSERT INTO rooms(id,code,name,invite,ends_at,retention,created_at,settings) VALUES('legacy-room','LEGACY','Legacy','legacy-invite',4102444800,86400,1,'{}');
INSERT INTO games(room_id,state) VALUES('legacy-room',?);`, raw); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestMigrationV7ToV9PreservesStateAndIDs(t *testing.T) {
	raw := "{\n  \"id\" : \"legacy-uno\",  \"kind\":\"uno\", \"phase\":\"turn\", \"language\":\"en\", \"version\":9, \"round\":3,\n  \"players\":[{\"id\":\"p\",\"name\":\"P\",\"alive\":true,\"score\":0,\"word\":\"keep-private\"}],\n  \"uno\":{\"player_count\":2,\"deck\":[{\"id\":7,\"color\":\"red\",\"type\":\"number\",\"value\":4}],\"discard\":[],\"hands\":[[{\"id\":8,\"color\":\"blue\",\"type\":\"skip\"}]],\"direction\":1,\"log\":[]}\n}"
	db := prepareV7GameMigration(t, raw)
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}
	var id, kind, preserved string
	var createdAt, updatedAt, humanJoinedAt, version int64
	if err := db.QueryRow("SELECT game_id,kind,state,created_at,updated_at,human_joined_at FROM games WHERE room_id='legacy-room'").Scan(&id, &kind, &preserved, &createdAt, &updatedAt, &humanJoinedAt); err != nil {
		t.Fatal(err)
	}
	if id != "legacy-uno" || kind != "uno" || preserved != raw {
		t.Fatalf("migration did not preserve game: id=%s kind=%s state=%q", id, kind, preserved)
	}
	if createdAt == 0 || updatedAt != createdAt {
		t.Fatalf("migration timestamps = %d/%d", createdAt, updatedAt)
	}
	if humanJoinedAt != createdAt {
		t.Fatalf("migration human marker = %d, created_at = %d", humanJoinedAt, createdAt)
	}
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, err=%v", version, err)
	}
	var violations int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_foreign_key_check").Scan(&violations); err != nil {
		t.Fatal(err)
	}
	if violations != 0 {
		t.Fatal("migration left foreign key violations")
	}
	if _, err := db.Exec("INSERT INTO guandan_games(room_id,game_id,native_room_id,created_by,created_at) VALUES('legacy-room','gd','native','creator',1)"); err != nil {
		t.Fatal(err)
	}
	var lastSeen, closed, humanJoined int
	if err := db.QueryRow("SELECT last_seen_at,closed_at,human_joined_at FROM guandan_games WHERE game_id='gd'").Scan(&lastSeen, &closed, &humanJoined); err != nil {
		t.Fatal(err)
	}
	if lastSeen != 0 || closed != 0 || humanJoined != 0 {
		t.Fatal("guandan timestamp defaults are wrong")
	}
	if _, err := db.Exec("DELETE FROM rooms WHERE id='legacy-room'"); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRow("SELECT (SELECT COUNT(*) FROM games)+(SELECT COUNT(*) FROM guandan_games)").Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatal("room deletion did not cascade to game tables")
	}
}

func TestMigrationV8RejectsMissingIDAndRollsBack(t *testing.T) {
	raw := `{"kind":"dice","phase":"lobby","version":3,"players":[]}`
	db := prepareV7GameMigration(t, raw)
	if err := migrate(db); err == nil {
		t.Fatal("migration accepted a game without an ID")
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 7 {
		t.Fatalf("rolled back schema version = %d", version)
	}
	var preserved string
	if err := db.QueryRow("SELECT state FROM games WHERE room_id='legacy-room'").Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if preserved != raw {
		t.Fatal("failed migration changed old state")
	}
	var columns, guandanTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('games')").Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='guandan_games'").Scan(&guandanTables); err != nil {
		t.Fatal(err)
	}
	if columns != 2 || guandanTables != 0 {
		t.Fatalf("migration was not rolled back: columns=%d guandan=%d", columns, guandanTables)
	}
}

func TestCleanupDeletesOnlyUnjoinedUnoAndGuanDanTables(t *testing.T) {
	f := newFixture(t)
	_, upstream := newGuanDanTestNative(t)
	f.s.config.GuanDanURL = upstream.URL

	staleUno := createMultiTestGame(t, f, f.host, "uno", 4)
	freshUno := createMultiTestGame(t, f, f.host, "uno", 4)
	joinedUno := createMultiTestGame(t, f, f.host, "uno", 4)
	dice := createMultiTestGame(t, f, f.host, "dice", 0)
	actMultiTestGame(t, f, f.host, joinedUno, "join")

	staleGuanDan := createGuanDanTable(t, f, f.host)
	freshGuanDan := createGuanDanTable(t, f, f.host)
	joinedGuanDan := createGuanDanTable(t, f, f.host)
	token := guandanTableToken(t, f, f.guest, f.room.ID, joinedGuanDan.ID)
	exchangeGuanDanToken(t, f, token)

	var unoMarker, guandanMarker int64
	if err := f.s.db.QueryRow("SELECT human_joined_at FROM games WHERE room_id=? AND game_id=?", f.room.ID, joinedUno.ID).Scan(&unoMarker); err != nil {
		t.Fatal(err)
	}
	if err := f.s.db.QueryRow("SELECT human_joined_at FROM guandan_games WHERE room_id=? AND game_id=?", f.room.ID, joinedGuanDan.ID).Scan(&guandanMarker); err != nil {
		t.Fatal(err)
	}
	if unoMarker == 0 || guandanMarker == 0 {
		t.Fatalf("human markers = UNO %d, GuanDan %d", unoMarker, guandanMarker)
	}

	old := time.Now().Unix() - 301
	for _, id := range []string{staleUno.ID, joinedUno.ID, dice.ID} {
		if _, err := f.s.db.Exec("UPDATE games SET created_at=? WHERE room_id=? AND game_id=?", old, f.room.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{staleGuanDan.ID, joinedGuanDan.ID} {
		if _, err := f.s.db.Exec("UPDATE guandan_games SET created_at=? WHERE room_id=? AND game_id=?", old, f.room.ID, id); err != nil {
			t.Fatal(err)
		}
	}

	f.s.cleanup()
	checks := []struct {
		table, id string
		want      int
	}{
		{"games", staleUno.ID, 0},
		{"games", freshUno.ID, 1},
		{"games", joinedUno.ID, 1},
		{"games", dice.ID, 1},
		{"guandan_games", staleGuanDan.ID, 0},
		{"guandan_games", freshGuanDan.ID, 1},
		{"guandan_games", joinedGuanDan.ID, 1},
	}
	for _, check := range checks {
		var count int
		if err := f.s.db.QueryRow("SELECT COUNT(*) FROM "+check.table+" WHERE room_id=? AND game_id=?", f.room.ID, check.id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != check.want {
			t.Fatalf("%s %s count = %d, want %d", check.table, check.id, count, check.want)
		}
	}
	var roomCount int
	if err := f.s.db.QueryRow("SELECT COUNT(*) FROM rooms WHERE id=?", f.room.ID).Scan(&roomCount); err != nil {
		t.Fatal(err)
	}
	if roomCount != 1 {
		t.Fatal("game cleanup deleted the outer RoomDeck room")
	}
}
