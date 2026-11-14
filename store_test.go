package main

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStoreServer(t *testing.T) (*hub, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	h := &hub{clients: map[string]*client{}, channels: []string{"general"}, store: st}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	return h, "ws" + strings.TrimPrefix(srv.URL, "http") + "/", path
}

func queryAll(t *testing.T, path, q string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// Cada motivo de salida, y la sesión aún abierta que cierra el apagado.
func TestSessionHistory(t *testing.T) {
	h, url, path := newStoreServer(t)
	a, b, c := dial(t, url), dial(t, url), dial(t, url)
	a.join("general", "ana")
	a.join("cine", "ana") // switch
	a.send(map[string]any{"type": "leave"})
	b.join("general", "bea")
	c.join("juegos", "cris")
	b.conn.CloseNow()

	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.Lock()
		n := len(h.clients)
		anaOut := true
		for _, cl := range h.clients {
			if cl.name == "ana" && cl.room != "" {
				anaOut = false
			}
		}
		h.mu.Unlock()
		if n == 2 && anaOut {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("el servidor no procesó las salidas")
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.store.Close()

	got := queryAll(t, path, `SELECT name || '/' || room || '/' || left_reason || '/' || (left_at IS NOT NULL) || '/' || ip FROM sessions ORDER BY rowid`)
	want := []string{
		"ana/general/switch/1/127.0.0.1",
		"ana/cine/leave/1/127.0.0.1",
		"bea/general/disconnect/1/127.0.0.1",
		"cris/juegos/server-stop/1/127.0.0.1",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("sesiones:\n%s\nquiero:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Un SDP lleva IPs y credenciales ICE: no debe acabar en disco.
func TestSignalIsNotRecorded(t *testing.T) {
	h, url, path := newStoreServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	a.send(map[string]any{"type": "signal", "to": b.id, "data": map[string]any{"sdp": "SECRETO"}})
	b.waitFor("signal")
	h.store.Close()

	for _, q := range []string{
		`SELECT count(*) FROM events WHERE coalesce(detail, '') LIKE '%SECRETO%'`,
		`SELECT count(*) FROM events WHERE kind NOT IN ('connect', 'disconnect')`,
	} {
		if got := queryAll(t, path, q); got[0] != "0" {
			t.Fatalf("%s = %s", q, got[0])
		}
	}
}

func TestRejectedOriginIsRecorded(t *testing.T) {
	h, url, path := newStoreServer(t)
	req, _ := http.NewRequest("GET", "http"+strings.TrimPrefix(url, "ws"), nil)
	for k, v := range map[string]string{
		"Connection":            "Upgrade",
		"Upgrade":               "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key":     "dGhlIHNhbXBsZSBub25jZQ==",
		"Origin":                "https://malo.example",
		"X-Forwarded-For":       "203.0.113.7",
	} {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", resp.StatusCode)
	}
	h.store.Close()
	got := queryAll(t, path, `SELECT detail || '|' || forwarded_for FROM events WHERE kind = 'ws-rejected'`)
	if len(got) != 1 || got[0] != "https://malo.example|203.0.113.7" {
		t.Fatalf("eventos: %v", got)
	}
}

func TestSessionsListsActiveFirstAndPrefersForwardedIP(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.sessionStart("s1", "c", "acabada", "general", netInfo{ip: "10.0.0.1"})
	st.sessionEnd("s1", "leave")
	st.sessionStart("s2", "c", "activa", "general", netInfo{ip: "127.0.0.1", forwarded: "203.0.113.7"})
	deadline := time.Now().Add(5 * time.Second)
	var got []sessionRow
	for len(got) < 2 {
		if got, err = st.sessions(10); err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("filas: %+v", got)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got[0].Name != "activa" || got[0].IP != "203.0.113.7" || got[1].IP != "10.0.0.1" || got[1].Reason != "leave" {
		t.Fatalf("filas: %+v", got)
	}
}

func TestLogLinesAreRecorded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Write([]byte("hola\n"))
	st.Close()
	if got := queryAll(t, path, `SELECT detail FROM events WHERE kind = 'log'`); len(got) != 1 || got[0] != "hola" {
		t.Fatalf("log: %v", got)
	}
}

// Una caída deja sesiones abiertas: el arranque las marca sin inventar la hora.
func TestStartupMarksInterruptedSessions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st.sessionStart("s1", "c1", "ana", "general", netInfo{})
	close(st.stop)
	<-st.done
	st.db.Close() // sin Close: simula la caída

	st, err = openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	got := queryAll(t, path, `SELECT left_reason || '/' || (left_at IS NULL) FROM sessions`)
	if len(got) != 1 || got[0] != "interrupted/1" {
		t.Fatalf("sesiones: %v", got)
	}
}
