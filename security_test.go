package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

var testStatic = fstest.MapFS{
	"index.html":  {Data: []byte("<!doctype html>")},
	"assets/a.js": {Data: []byte("1")},
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	h := &hub{clients: map[string]*client{}}
	srv := httptest.NewServer(newMux(h, testStatic))
	defer srv.Close()
	for _, path := range []string{"/", "/assets/a.js", "/no-existe"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		csp := resp.Header.Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: CSP sin %q: %s", path, want, csp)
			}
		}
		// Solo se admite compilar WebAssembly; nada de eval ni inline.
		if strings.Contains(strings.ReplaceAll(csp, "'wasm-unsafe-eval'", ""), "unsafe") || strings.Contains(csp, "googleapis") {
			t.Errorf("%s: CSP relajado: %s", path, csp)
		}
		for k, v := range map[string]string{"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"} {
			if resp.Header.Get(k) != v {
				t.Errorf("%s: %s = %q", path, k, resp.Header.Get(k))
			}
		}
	}
}

func TestStaticDoesNotListDirectories(t *testing.T) {
	srv := httptest.NewServer(newMux(&hub{clients: map[string]*client{}}, testStatic))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/assets/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestForeignOriginRejected(t *testing.T) {
	_, url := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://malo.example"}}}
	if conn, _, err := websocket.Dial(ctx, url, opts); err == nil {
		conn.CloseNow()
		t.Fatal("origen ajeno aceptado")
	}
}

func TestForwardedForIsOnlyTrustedFromLoopback(t *testing.T) {
	for _, tc := range []struct{ remote, header, want string }{
		{"203.0.113.9:1000", "198.51.100.1", "203.0.113.9"}, // directo: la cabecera la escribe el cliente
		{"127.0.0.1:1000", "198.51.100.1", "198.51.100.1"},
		{"127.0.0.1:1000", "1.2.3.4, 198.51.100.1", "198.51.100.1"}, // lo falso va delante
		{"127.0.0.1:1000", "", "127.0.0.1"},
	} {
		r := httptest.NewRequest("GET", "/ws", nil)
		r.RemoteAddr = tc.remote
		if tc.header != "" {
			r.Header.Set("X-Forwarded-For", tc.header)
		}
		if got := netInfoFrom(r).clientIP(); got != tc.want {
			t.Errorf("%+v: %s", tc, got)
		}
	}
}

func TestPendingConnectionsPerIPAreLimited(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: testKey}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	var open []*testClient
	for range maxPendingPerIP {
		c := dialRaw(t, url)
		c.waitFor("auth-required")
		open = append(open, c)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if conn, resp, err := websocket.Dial(ctx, url, nil); err == nil {
		conn.CloseNow()
		t.Fatal("aceptada por encima del límite")
	} else if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("respuesta: %v %v", resp, err)
	}
	// Autenticarse libera el hueco.
	c := open[0]
	c.conn.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.Lock()
		n := h.pending["127.0.0.1"]
		h.mu.Unlock()
		if n < maxPendingPerIP {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("el hueco no se libera")
		}
		time.Sleep(5 * time.Millisecond)
	}
	d := dialRaw(t, url)
	d.prove(testKey, d.waitFor("auth-required").Nonce)
	d.waitFor("hello")
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending["127.0.0.1"] != maxPendingPerIP-1 {
		t.Fatalf("pendientes: %d", h.pending["127.0.0.1"])
	}
}

func TestRoomCap(t *testing.T) {
	h := &hub{clients: map[string]*client{}, maxRoom: 2}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	a, b, c := dial(t, url), dial(t, url), dial(t, url)
	a.join("sala", "ana")
	b.join("sala", "bea")
	a.waitFor("peer-joined")
	c.send(map[string]any{"type": "join", "room": "SALA", "name": "cris"})
	if m := c.waitFor("room-full"); !strings.EqualFold(m.Room, "sala") {
		t.Fatalf("room-full: %+v", m)
	}
	// Quien ya está dentro puede volver a entrar: no cuenta contra sí mismo.
	a.send(map[string]any{"type": "join", "room": "sala", "name": "ana"})
	a.waitFor("joined")
}

func TestFloodIsCut(t *testing.T) {
	_, url := newTestServer(t)
	c := dial(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var err error
	for range 5000 {
		if err = c.conn.Write(ctx, websocket.MessageText, []byte(`{"type":"leave"}`)); err != nil {
			break
		}
	}
	for err == nil {
		_, _, err = c.conn.Read(ctx)
	}
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("cierre: %v", err)
	}
}

func TestOversizedMessageIsCut(t *testing.T) {
	_, url := newTestServer(t)
	c := dial(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	big := `{"type":"signal","to":"x","data":"` + strings.Repeat("a", signalLimit+1) + `"}`
	c.conn.Write(ctx, websocket.MessageText, []byte(big))
	var err error
	for err == nil {
		_, _, err = c.conn.Read(ctx)
	}
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("cierre: %v", err)
	}
}

func TestCleanStripsInvisibleCharacters(t *testing.T) {
	for in, want := range map[string]string{
		"an​a":        "ana", // anchura cero
		"‮ana":        "ana", // inversión bidi
		"a\x00n\x1fa": "ana", // controles
		"ana\xff":     "ana", // UTF-8 inválido
		"⁦⁩":          "",    // solo formato: queda vacío y el join se ignora
	} {
		if got := clean(in, 32); got != want {
			t.Errorf("clean(%q) = %q", in, got)
		}
	}
}

func TestTurnCredentialsFollowCoturnScheme(t *testing.T) {
	at := time.Unix(1000, 0)
	user, cred := turnCredentials("secreto", "c1", time.Hour, at)
	if user != "4600:c1" {
		t.Fatalf("usuario %s", user)
	}
	mac := hmac.New(sha1.New, []byte("secreto"))
	mac.Write([]byte(user))
	if cred != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("credencial")
	}
	h := &hub{clients: map[string]*client{}, turnSecret: "s", turnURLs: []string{"turn:x"}, ice: []iceServer{{URLs: []string{"stun:y"}}}}
	if got := h.iceFor(&client{id: "c"}); len(got) != 2 || got[1].Credential == "" || len(h.ice) != 1 {
		t.Fatalf("ice: %+v", got)
	}
}

// El modo -join: interfaz local, señalización remota, y nadie más puede usar el puerto.
func TestJoinProxy(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: testKey, channels: []string{"general"}}
	upstream := httptest.NewServer(newMux(h, testStatic))
	defer upstream.Close()
	target, err := parseJoinTarget(upstream.URL + "/#k=NO-DEBE-PASAR")
	if err != nil {
		t.Fatal(err)
	}
	if target.Fragment != "" {
		t.Fatalf("fragmento conservado: %v", target)
	}
	local := httptest.NewServer(newJoinHandler(target, testStatic))
	defer local.Close()
	host := strings.TrimPrefix(local.URL, "http://")
	wsURL := "ws://" + host + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://" + host}}})
	if err != nil {
		t.Fatal(err)
	}
	c := &testClient{t: t, conn: conn}
	t.Cleanup(func() { conn.CloseNow() })
	c.prove(testKey, c.waitFor("auth-required").Nonce)
	c.waitFor("hello")

	// Otra web abierta en el navegador no puede hablar por este puerto.
	if bad, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://malo.example"}}}); err == nil {
		bad.CloseNow()
		t.Fatal("origen ajeno aceptado en -join")
	}
	// Ni apuntar su dominio a 127.0.0.1 (DNS rebinding).
	req, _ := http.NewRequest("GET", local.URL+"/", nil)
	req.Host = "malo.example"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("host ajeno: %d", resp.StatusCode)
	}
}

func TestJoinTargetRequiresHTTPS(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://a.example/x":   true,
		"http://127.0.0.1:8080": true,
		"http://a.example":      false,
		"ftp://a.example":       false,
		"":                      false,
	} {
		if _, err := parseJoinTarget(raw); (err == nil) != ok {
			t.Errorf("%q: %v", raw, err)
		}
	}
}

func TestLoopbackDetection(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:8080": true, "localhost:80": true, "[::1]:80": true,
		":8080": false, "0.0.0.0:80": false, "192.168.1.5:80": false, "malo.example:80": false,
	} {
		if isLoopbackAddr(addr) != want {
			t.Errorf("%s", addr)
		}
	}
}

func TestPruneDeletesExpiredRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStoreRetention(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	st.apply(dbOp{`INSERT INTO sessions (id, client_id, name, room, joined_at, left_at, left_reason) VALUES ('viejo', 'c', 'SECRETO-VIEJO', 'r', ?, ?, 'leave')`, []any{old, old}})
	st.apply(dbOp{`INSERT INTO sessions (id, client_id, name, room, joined_at) VALUES ('activo', 'c', 'activo', 'r', ?)`, []any{old}})
	st.apply(dbOp{`INSERT INTO events (ts, kind) VALUES (?, 'connect')`, []any{old}})
	st.event("connect", "c", "", netInfo{}, "reciente")
	st.prune(time.Now())
	st.Close()
	if got := queryAll(t, path, `SELECT id FROM sessions`); len(got) != 1 || got[0] != "activo" {
		t.Fatalf("sesiones: %v", got)
	}
	if got := queryAll(t, path, `SELECT detail FROM events`); len(got) != 1 || got[0] != "reciente" {
		t.Fatalf("eventos: %v", got)
	}
}

func TestClearEmptiesLogs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st.sessionStart("s", "c", "ana", "r", netInfo{ip: "1.2.3.4"})
	st.sessionEnd("s", "leave")
	st.event("connect", "c", "", netInfo{ip: "1.2.3.4"}, "")
	st.Clear()
	st.Close()
	if got := queryAll(t, path, `SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM events)`); got[0] != "0" {
		t.Fatalf("filas: %v", got)
	}
}

// Con no-cache, el ETag evita volver a bajar lo mismo (el modelo del dictado son ~100 MB).
func TestStaticFilesRevalidateWithETag(t *testing.T) {
	srv := httptest.NewServer(newMux(&hub{clients: map[string]*client{}}, testStatic))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/assets/a.js")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	tag := resp.Header.Get("ETag")
	if tag == "" || resp.StatusCode != http.StatusOK {
		t.Fatalf("sin ETag: %d %q", resp.StatusCode, tag)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/assets/a.js", nil)
	req.Header.Set("If-None-Match", tag)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidar con el mismo ETag: %d, se esperaba 304", resp.StatusCode)
	}
}
