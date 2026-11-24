package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

const testUserPassword = "regular-user-password-2026"

type testAccountStatus struct {
	Authenticated bool   `json:"authenticated"`
	Username      string `json:"username"`
	Role          string `json:"role"`
}

func createTestUser(t *testing.T, f *fixture, username string) managedUser {
	t.Helper()
	var user managedUser
	f.request(t, f.host, "POST", "/users", map[string]string{
		"username": username,
		"password": testUserPassword,
	}, 201, &user)
	if user.ID == "" || user.Username != username || user.RoomCount != 0 {
		t.Fatalf("unexpected created user: %+v", user)
	}
	return user
}

func loginTestUser(t *testing.T, f *fixture, c *http.Client, username string) {
	t.Helper()
	f.request(t, c, "POST", "/login", map[string]string{
		"username": username,
		"password": testUserPassword,
	}, 200, nil)
}

func TestUserManagementAuthenticationAndAdminOnlyAPIs(t *testing.T) {
	f := newFixture(t)
	f.request(t, f.other, "GET", "/users", nil, 401, nil)

	user := createTestUser(t, f, "regular")
	f.request(t, f.host, "POST", "/users", map[string]string{
		"username": "regular",
		"password": testUserPassword,
	}, 409, nil)
	f.request(t, f.host, "POST", "/users", map[string]string{
		"username": "short-password",
		"password": "too-short",
	}, 400, nil)

	var users []managedUser
	f.request(t, f.host, "GET", "/users", nil, 200, &users)
	if len(users) != 1 || users[0].ID != user.ID {
		t.Fatalf("user list must contain only the regular user: %+v", users)
	}

	regular := client()
	loginTestUser(t, f, regular, "regular")
	var status testAccountStatus
	f.request(t, regular, "GET", "/status", nil, 200, &status)
	if !status.Authenticated || status.Username != "regular" || status.Role != "user" {
		t.Fatalf("unexpected regular-user status: %+v", status)
	}
	f.request(t, regular, "GET", "/users", nil, 403, nil)
	f.request(t, regular, "POST", "/users", map[string]string{
		"username": "another",
		"password": testUserPassword,
	}, 403, nil)
	f.request(t, regular, "DELETE", "/users/"+user.ID, nil, 403, nil)

	var adminID string
	if err := f.s.db.QueryRow("SELECT id FROM admins WHERE username='host'").Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	f.request(t, f.host, "DELETE", "/users/"+adminID, nil, 409, nil)
	f.request(t, f.host, "DELETE", "/users/missing", nil, 404, nil)

	f.request(t, regular, "POST", "/logout", nil, 200, nil)
	f.request(t, regular, "GET", "/status", nil, 200, &status)
	if status.Authenticated || status.Role != "" {
		t.Fatalf("logout did not clear the account session: %+v", status)
	}
	f.request(t, regular, "GET", "/rooms", nil, 401, nil)
}

func TestUserRoomOwnershipIsolationAndAdminAccess(t *testing.T) {
	f := newFixture(t)
	firstUser := createTestUser(t, f, "first-user")
	createTestUser(t, f, "second-user")
	first := client()
	second := client()
	loginTestUser(t, f, first, "first-user")
	loginTestUser(t, f, second, "second-user")

	var owned Room
	f.request(t, first, "POST", "/rooms", map[string]interface{}{
		"name": "Owned room", "duration": 7200, "retention": 86400,
	}, 201, &owned)
	if owned.OwnerID != firstUser.ID {
		t.Fatalf("room owner = %q, want %q", owned.OwnerID, firstUser.ID)
	}
	var firstRooms, secondRooms, adminRooms []Room
	f.request(t, first, "GET", "/rooms", nil, 200, &firstRooms)
	f.request(t, second, "GET", "/rooms", nil, 200, &secondRooms)
	if len(firstRooms) != 1 || firstRooms[0].ID != owned.ID || len(secondRooms) != 0 {
		t.Fatalf("room lists leaked ownership: first=%+v second=%+v", firstRooms, secondRooms)
	}

	f.request(t, first, "POST", "/rooms/"+owned.ID+"/contents", map[string]string{
		"kind": "note", "body": "owned activity",
	}, 201, nil)
	f.request(t, first, "POST", "/rooms/"+owned.ID+"/games", gameCommand{
		Action: "create", Kind: "dice", Language: "en",
	}, 200, nil)
	f.request(t, first, "POST", "/rooms/"+owned.ID+"/invite", nil, 200, nil)

	f.request(t, second, "GET", "/rooms/"+owned.ID+"/snapshot", nil, 403, nil)
	f.request(t, second, "POST", "/rooms/"+owned.ID+"/contents", map[string]string{
		"kind": "note", "body": "intrusion",
	}, 403, nil)
	f.request(t, second, "POST", "/rooms/"+owned.ID+"/close", nil, 403, nil)
	f.request(t, second, "DELETE", "/rooms/"+owned.ID, map[string]string{"name": owned.Name}, 403, nil)
	f.request(t, second, "POST", "/rooms/"+owned.ID+"/invite", nil, 403, nil)
	f.request(t, second, "POST", "/rooms/"+owned.ID+"/display-session", nil, 403, nil)
	f.request(t, second, "POST", "/rooms/"+owned.ID+"/exports", nil, 403, nil)

	f.request(t, f.host, "GET", "/rooms", nil, 200, &adminRooms)
	if len(adminRooms) != 2 {
		t.Fatalf("administrator should see all rooms: %+v", adminRooms)
	}
	f.request(t, f.host, "GET", "/rooms/"+owned.ID+"/snapshot", nil, 200, nil)
	f.request(t, f.host, "POST", "/rooms/"+owned.ID+"/display-session", nil, 201, nil)

	if _, err := f.s.db.Exec("UPDATE rooms SET owner_id=NULL WHERE id=?", f.room.ID); err != nil {
		t.Fatal(err)
	}
	f.request(t, first, "GET", f.path("/snapshot"), nil, 403, nil)
	f.request(t, f.host, "POST", f.path("/close"), nil, 200, nil)
	f.request(t, f.host, "POST", "/rooms/"+owned.ID+"/close", nil, 200, nil)
}

func TestDeleteUserCascadesRoomsActivitiesFilesAndSessions(t *testing.T) {
	f := newFixture(t)
	user := createTestUser(t, f, "delete-me")
	regular := client()
	loginTestUser(t, f, regular, "delete-me")
	var owned Room
	f.request(t, regular, "POST", "/rooms", map[string]interface{}{
		"name": "Delete everything", "duration": 7200, "retention": 86400,
	}, 201, &owned)
	f.request(t, f.other, "POST", "/join", joinInput{Code: owned.Code, Name: "Owned guest"}, 201, nil)
	f.request(t, regular, "POST", "/rooms/"+owned.ID+"/contents", map[string]string{
		"kind": "note", "body": "delete this activity",
	}, 201, nil)
	f.request(t, regular, "POST", "/rooms/"+owned.ID+"/games", gameCommand{
		Action: "create", Kind: "dice", Language: "en",
	}, 200, nil)

	data := []byte("owned file")
	query := url.Values{"kind": {"file"}, "name": {"owned.txt"}, "size": {"10"}}
	req, err := http.NewRequest("POST", f.ts.URL+"/api/v1/rooms/"+owned.ID+"/assets?"+query.Encode(), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-RoomDeck-Request", "1")
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := f.other.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 201 {
		t.Fatalf("owned-room upload failed: status=%d error=%v body=%s", res.StatusCode, err, body)
	}
	var uploaded map[string]string
	if err = json.Unmarshal(body, &uploaded); err != nil || uploaded["id"] == "" {
		t.Fatalf("invalid upload response: %s", body)
	}

	if _, err = f.s.db.Exec("INSERT INTO screens(room_id,id,owner,name,expires) VALUES(?,'screen','owner','Screen',4102444800)", owned.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.db.Exec("INSERT INTO media_clients(id,room_id,screen_id,session_hash,role,participant_id,expires) VALUES('media',?,'screen','hash','guest','participant',4102444800)", owned.ID); err != nil {
		t.Fatal(err)
	}
	uploadDir := filepath.Join(f.s.config.DataDir, "uploads", owned.ID)
	if err = os.MkdirAll(uploadDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(uploadDir, "pending"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}

	var deleted struct {
		DeletedRooms int `json:"deleted_rooms"`
	}
	f.request(t, f.host, "DELETE", "/users/"+user.ID, nil, 200, &deleted)
	if deleted.DeletedRooms != 1 {
		t.Fatalf("deleted rooms = %d, want 1", deleted.DeletedRooms)
	}

	checks := []struct {
		query string
		arg   string
	}{
		{"SELECT COUNT(*) FROM admins WHERE id=?", user.ID},
		{"SELECT COUNT(*) FROM rooms WHERE id=?", owned.ID},
		{"SELECT COUNT(*) FROM contents WHERE room_id=?", owned.ID},
		{"SELECT COUNT(*) FROM games WHERE room_id=?", owned.ID},
		{"SELECT COUNT(*) FROM participants WHERE room_id=?", owned.ID},
		{"SELECT COUNT(*) FROM sessions WHERE room_id=?", owned.ID},
		{"SELECT COUNT(*) FROM sessions WHERE role='host' AND participant_id=?", user.ID},
		{"SELECT COUNT(*) FROM screens WHERE room_id=?", owned.ID},
		{"SELECT COUNT(*) FROM media_clients WHERE room_id=?", owned.ID},
	}
	for _, check := range checks {
		var count int
		if err = f.s.db.QueryRow(check.query, check.arg).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("cascade left %d rows for %s", count, check.query)
		}
	}
	for _, dir := range []string{
		filepath.Join(f.s.config.DataDir, "rooms", owned.ID),
		uploadDir,
	} {
		if _, err = os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("owned-room directory remains: %s", dir)
		}
	}

	var status testAccountStatus
	f.request(t, regular, "GET", "/status", nil, 200, &status)
	if status.Authenticated {
		t.Fatal("deleted user's host session is still valid")
	}
	f.request(t, regular, "GET", "/rooms", nil, 401, nil)
	f.request(t, regular, "POST", "/login", map[string]string{
		"username": "delete-me", "password": testUserPassword,
	}, 401, nil)
	f.request(t, f.other, "GET", "/rooms/"+owned.ID+"/snapshot", nil, 404, nil)
	f.request(t, f.guest, "GET", f.path("/snapshot"), nil, 200, nil)
	f.request(t, f.host, "GET", f.path("/snapshot"), nil, 200, nil)
}
