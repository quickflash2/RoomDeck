package server

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

type managedUser struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	RoomCount int    `json:"room_count"`
}

func (s *Server) admin(w http.ResponseWriter, r *http.Request) *principal {
	p := s.host(w, r)
	if p == nil {
		return nil
	}
	if p.AccountRole != "admin" {
		apiError(w, http.StatusForbidden, "FORBIDDEN")
		return nil
	}
	return p
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if s.admin(w, r) == nil {
		return
	}
	rows, err := s.db.Query(`SELECT a.id,a.username,COUNT(r.id)
		FROM admins a LEFT JOIN rooms r ON r.owner_id=a.id
		WHERE a.role='user' GROUP BY a.id,a.username ORDER BY a.username COLLATE NOCASE`)
	if err != nil {
		s.internal(w, err)
		return
	}
	defer rows.Close()
	users := []managedUser{}
	for rows.Next() {
		var user managedUser
		if err = rows.Scan(&user.ID, &user.Username, &user.RoomCount); err != nil {
			s.internal(w, err)
			return
		}
		users = append(users, user)
	}
	if err = rows.Err(); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	p := s.admin(w, r)
	if p == nil {
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !validText(in.Username, 1, 40) || len(in.Password) < 12 || len(in.Password) > 72 {
		apiError(w, http.StatusBadRequest, "CREDENTIALS_INVALID")
		return
	}
	hashed, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		s.internal(w, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	if err = s.db.QueryRow("SELECT COUNT(*) FROM admins WHERE username=?", strings.TrimSpace(in.Username)).Scan(&count); err != nil {
		s.internal(w, err)
		return
	}
	if count != 0 {
		apiError(w, http.StatusConflict, "USERNAME_EXISTS")
		return
	}
	user := managedUser{ID: randomID(16), Username: strings.TrimSpace(in.Username)}
	_, err = s.db.Exec("INSERT INTO admins(id,username,password,role) VALUES(?,?,?,'user')", user.ID, user.Username, hashed)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			apiError(w, http.StatusConflict, "USERNAME_EXISTS")
		} else {
			s.internal(w, err)
		}
		return
	}
	s.audit("", "user.created", p.ID)
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	p := s.admin(w, r)
	if p == nil {
		return
	}
	userID := r.PathValue("user")
	s.mu.Lock()
	defer s.mu.Unlock()
	var role string
	err := s.db.QueryRow("SELECT role FROM admins WHERE id=?", userID).Scan(&role)
	if err == sql.ErrNoRows {
		apiError(w, http.StatusNotFound, "USER_NOT_FOUND")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if role != "user" {
		apiError(w, http.StatusConflict, "USER_ADMIN_DELETE")
		return
	}
	rows, err := s.db.Query("SELECT id FROM rooms WHERE owner_id=?", userID)
	if err != nil {
		s.internal(w, err)
		return
	}
	roomIDs := []string{}
	for rows.Next() {
		var roomID string
		if err = rows.Scan(&roomID); err != nil {
			rows.Close()
			s.internal(w, err)
			return
		}
		roomIDs = append(roomIDs, roomID)
	}
	if err = rows.Close(); err != nil {
		s.internal(w, err)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		s.internal(w, err)
		return
	}
	defer tx.Rollback()
	ownedRooms := "(SELECT id FROM rooms WHERE owner_id=?)"
	if _, err = tx.Exec("DELETE FROM sessions WHERE room_id IN "+ownedRooms, userID); err != nil {
		s.internal(w, err)
		return
	}
	if _, err = tx.Exec("DELETE FROM sessions WHERE role='host' AND participant_id=?", userID); err != nil {
		s.internal(w, err)
		return
	}
	if _, err = tx.Exec("DELETE FROM screens WHERE room_id IN "+ownedRooms, userID); err != nil {
		s.internal(w, err)
		return
	}
	if _, err = tx.Exec("DELETE FROM media_clients WHERE room_id IN "+ownedRooms, userID); err != nil {
		s.internal(w, err)
		return
	}
	result, err := tx.Exec("DELETE FROM admins WHERE id=? AND role='user'", userID)
	if err != nil {
		s.internal(w, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		apiError(w, http.StatusNotFound, "USER_NOT_FOUND")
		return
	}
	if err = tx.Commit(); err != nil {
		s.internal(w, err)
		return
	}
	owned := make(map[string]bool, len(roomIDs))
	for _, roomID := range roomIDs {
		owned[roomID] = true
		s.hub.notify(roomID)
		s.audit(roomID, "room.deleted", p.ID)
		if err = os.RemoveAll(filepath.Join(s.config.DataDir, "rooms", roomID)); err != nil {
			log.Printf("delete user room files %s: %v", roomID, err)
		}
		if err = os.RemoveAll(filepath.Join(s.config.DataDir, "uploads", roomID)); err != nil {
			log.Printf("delete user upload files %s: %v", roomID, err)
		}
	}
	s.guandanMu.Lock()
	for key, session := range s.guandan {
		if session.PlayerID == userID || owned[session.RoomID] {
			delete(s.guandan, key)
		}
	}
	s.guandanMu.Unlock()
	s.audit("", "user.deleted", p.ID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "deleted_rooms": len(roomIDs)})
}
