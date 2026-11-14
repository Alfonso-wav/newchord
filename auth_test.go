package main

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var (
	testKey = []byte("verificador-de-prueba-0123456789")
	oldKey  = []byte("verificador-antiguo-000000000000")
)

func newAuthServer(t *testing.T, st *store) string {
	t.Helper()
	h := &hub{clients: map[string]*client{}, channels: []string{"general"}, verifier: testKey, store: st}
	h.ice = []iceServer{{URLs: []string{"turn:secreto:3478"}, Credential: "TURNPASS"}}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
}

func dialRaw(t *testing.T, url string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &testClient{t: t, conn: conn}
}

func (c *testClient) prove(key []byte, nonce string) {
	c.t.Helper()
	c.send(map[string]any{"type": "auth", "proof": hex.EncodeToString(authProof(key, nonce))})
}

func TestProofGatesHello(t *testing.T) {
	url := newAuthServer(t, nil)
	c := dialRaw(t, url)
	nonce := c.waitFor("auth-required").Nonce

	// Fuera de "auth" nada surte efecto: el siguiente mensaje es la respuesta al fallo.
	c.send(map[string]any{"type": "join", "room": "general", "name": "intruso"})
	c.prove(oldKey, nonce)
	nonce = c.waitFor("auth-failed").Nonce

	// Reintento en la misma conexión, con reto nuevo.
	c.prove(testKey, nonce)
	if m := c.waitFor("hello"); m.ID == "" || len(m.ICE) != 1 {
		t.Fatalf("hello: %+v", m)
	}
	if m := c.join("general", "ana"); m.Room != "general" {
		t.Fatalf("joined: %+v", m)
	}
}

// Una prueba capturada no sirve para entrar más tarde: cada conexión tiene su reto.
func TestProofCannotBeReplayed(t *testing.T) {
	url := newAuthServer(t, nil)
	first := dialRaw(t, url)
	nonce := first.waitFor("auth-required").Nonce
	first.prove(testKey, nonce)
	first.waitFor("hello")

	second := dialRaw(t, url)
	if again := second.waitFor("auth-required").Nonce; again == nonce {
		t.Fatal("reto repetido")
	}
	second.prove(testKey, nonce)
	second.waitFor("auth-failed")
}

func TestTooManyFailuresClose(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: testKey}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	c := dialRaw(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/")
	nonce := c.waitFor("auth-required").Nonce
	for range maxAuthFails {
		c.prove(oldKey, nonce)
		nonce = c.waitFor("auth-failed").Nonce
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var m testMsg
	if err := wsjson.Read(ctx, c.conn, &m); err == nil {
		t.Fatalf("sigue abierta: %+v", m)
	}
}

// Quien no se autentica no aparece en las salas ni recibe los cambios de otros.
func TestUnauthenticatedIsInvisible(t *testing.T) {
	url := newAuthServer(t, nil)
	mirón := dialRaw(t, url)
	mironNonce := mirón.waitFor("auth-required").Nonce

	ana := dialRaw(t, url)
	ana.prove(testKey, ana.waitFor("auth-required").Nonce)
	if m := ana.waitFor("hello"); len(m.Rooms) != 1 || len(m.Rooms[0].Members) != 0 {
		t.Fatalf("salas: %+v", m.Rooms)
	}
	ana.join("general", "ana")

	mirón.prove(oldKey, mironNonce)
	var m testMsg
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Read(ctx, mirón.conn, &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != "auth-failed" {
		t.Fatalf("el mirón recibió %q", m.Type)
	}
}

func TestFailuresAreThrottledAcrossConnections(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: testKey, authDelay: 100 * time.Millisecond}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"

	a, b, c := dialRaw(t, url), dialRaw(t, url), dialRaw(t, url)
	nonces := map[*testClient]string{}
	for _, x := range []*testClient{a, b, c} {
		nonces[x] = x.waitFor("auth-required").Nonce
	}
	start := time.Now()
	for _, x := range []*testClient{a, b, c} {
		x.prove(oldKey, nonces[x])
	}
	for _, x := range []*testClient{a, b, c} {
		x.waitFor("auth-failed")
	}
	if d := time.Since(start); d < 300*time.Millisecond {
		t.Fatalf("tres fallos en %v: no se serializan", d)
	}

	// La clave buena no espera tras los fallos de otros.
	d := dialRaw(t, url)
	d.prove(testKey, d.waitFor("auth-required").Nonce)
	d.waitFor("hello")
}

func TestProofNeverReachesDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	url := newAuthServer(t, st)
	c := dialRaw(t, url)
	nonce := c.waitFor("auth-required").Nonce
	bad := hex.EncodeToString(authProof(oldKey, nonce))
	c.send(map[string]any{"type": "auth", "proof": bad})
	nonce = c.waitFor("auth-failed").Nonce
	c.prove(testKey, nonce)
	c.waitFor("hello")
	st.Close()

	if got := queryAll(t, path, `SELECT count(*) FROM events WHERE kind = 'auth-failed'`); got[0] != "1" {
		t.Fatalf("auth-failed: %v", got)
	}
	matches, _ := filepath.Glob(path + "*")
	for _, f := range matches {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), bad) {
			t.Fatalf("prueba en %s", f)
		}
	}
}

func TestNoVerifierSkipsAuthInTests(t *testing.T) {
	_, url := newTestServer(t)
	c := dialRaw(t, url)
	c.waitFor("hello")
}

func TestSetVerifierDisconnectsEveryone(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: oldKey}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	c := dialRaw(t, url)
	c.prove(oldKey, c.waitFor("auth-required").Nonce)
	c.waitFor("hello")
	c.join("general", "ana")

	h.setVerifier(testKey)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var m testMsg
		if err := wsjson.Read(ctx, c.conn, &m); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				t.Fatalf("cierre: %v", err)
			}
			break
		}
	}
	d := dialRaw(t, url)
	d.prove(oldKey, d.waitFor("auth-required").Nonce)
	nonce := d.waitFor("auth-failed").Nonce
	d.prove(testKey, nonce)
	d.waitFor("hello")
}

// Vector compartido con web/test/e2e.test.mjs: si cambia uno, los navegadores dejan de entrar.
func TestDerivationVector(t *testing.T) {
	v, err := deriveVerifier("  clave de prueba compartida\n")
	if err != nil {
		t.Fatal(err)
	}
	const want = "59f1236caf8b0eb689f509932be67671703be6051b1a8e0e0c35cca049e5d99a"
	if got := hex.EncodeToString(v); got != want {
		t.Fatalf("verificador %s", got)
	}
	if got := hex.EncodeToString(authProof(v, "reto")); got != "d2144718f194dec9ae0d1ed85a7a7dc9f57983c4a62950f50a323fa512ce4c2b" {
		t.Fatalf("prueba %s", got)
	}
}

func TestServerVerifierRequiresStrongKey(t *testing.T) {
	for _, k := range []string{"CRYPTOPO_VERIFIER", "CRYPTOPO_PASSWORD", "NEWCHORD_VERIFIER", "NEWCHORD_PASSWORD"} {
		t.Setenv(k, "")
	}
	if _, err := serverVerifier("", "", ""); err == nil {
		t.Fatal("arranca sin clave")
	}
	if _, err := serverVerifier("corta", "", ""); err == nil {
		t.Fatal("acepta una clave corta")
	}
	if _, err := serverVerifier("", "", "abcd"); err == nil {
		t.Fatal("acepta un verificador mal formado")
	}
	if _, err := serverVerifier("una clave suficientemente larga", "", ""); err != nil {
		t.Fatal(err)
	}
}
