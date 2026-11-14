package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type testMsg struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Nonce string          `json:"nonce"`
	Name  string          `json:"name"`
	Room  string          `json:"room"`
	From  string          `json:"from"`
	Data  json.RawMessage `json:"data"`
	Peers []peerInfo      `json:"peers"`
	Rooms []roomInfo      `json:"rooms"`
	ICE   []iceServer     `json:"ice"`
}

type testClient struct {
	t    *testing.T
	conn *websocket.Conn
	id   string
}

func newTestServer(t *testing.T) (*hub, string) {
	t.Helper()
	h := &hub{clients: map[string]*client{}, channels: []string{"general", "cine"}}
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	return h, "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
}

func dial(t *testing.T, url string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	c := &testClient{t: t, conn: conn}
	c.id = c.waitFor("hello").ID
	return c
}

func (c *testClient) send(v map[string]any) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c.conn, v); err != nil {
		c.t.Fatal(err)
	}
}

// waitFor descarta los "rooms" intermedios; cualquier otro tipo inesperado es
// un fallo, para detectar mensajes que no deberían haber llegado.
func (c *testClient) waitFor(typ string) testMsg {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var m testMsg
		if err := wsjson.Read(ctx, c.conn, &m); err != nil {
			c.t.Fatalf("esperando %q: %v", typ, err)
		}
		if m.Type == typ {
			return m
		}
		if m.Type != "rooms" {
			c.t.Fatalf("esperaba %q, llegó %q", typ, m.Type)
		}
	}
}

func (c *testClient) join(room, name string) testMsg {
	c.t.Helper()
	c.send(map[string]any{"type": "join", "room": room, "name": name})
	return c.waitFor("joined")
}

func TestHelloIncludesICEAndChannels(t *testing.T) {
	h, url := newTestServer(t)
	h.ice = []iceServer{{URLs: []string{"stun:example:3478"}}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var m testMsg
	if err := wsjson.Read(ctx, conn, &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != "hello" || m.ID == "" {
		t.Fatalf("hello inválido: %+v", m)
	}
	if len(m.ICE) != 1 || m.ICE[0].URLs[0] != "stun:example:3478" {
		t.Fatalf("ICE: %+v", m.ICE)
	}
	if len(m.Rooms) != 2 || m.Rooms[0].Name != "general" || m.Rooms[1].Name != "cine" {
		t.Fatalf("canales fijos: %+v", m.Rooms)
	}
}

func TestJoinPresentsPeers(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	if got := a.join("general", "ana"); len(got.Peers) != 0 {
		t.Fatalf("sala vacía, peers: %+v", got.Peers)
	}
	got := b.join("general", "bea")
	if len(got.Peers) != 1 || got.Peers[0].ID != a.id || got.Peers[0].Name != "ana" {
		t.Fatalf("peers: %+v", got.Peers)
	}
	if m := a.waitFor("peer-joined"); m.ID != b.id || m.Name != "bea" {
		t.Fatalf("peer-joined: %+v", m)
	}
}

func TestSignalRoutedWithinRoom(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	a.send(map[string]any{"type": "signal", "to": b.id, "data": map[string]any{"x": 1}})
	m := b.waitFor("signal")
	if m.From != a.id || string(m.Data) != `{"x":1}` {
		t.Fatalf("signal: %+v data=%s", m, m.Data)
	}
}

// El servidor no debe ser un relay entre salas. waitFor falla si llega el
// "signal" antes que el "peer-joined" que A provoca justo después.
func TestSignalBlockedAcrossRooms(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("r1", "ana")
	b.join("r2", "bea")
	a.send(map[string]any{"type": "signal", "to": b.id, "data": map[string]any{"x": 1}})
	a.join("r2", "ana")
	if m := b.waitFor("peer-joined"); m.ID != a.id {
		t.Fatalf("peer-joined: %+v", m)
	}
}

func TestDisconnectNotifiesPeers(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	b.conn.CloseNow()
	if m := a.waitFor("peer-left"); m.ID != b.id {
		t.Fatalf("peer-left: %+v", m)
	}
}

func TestLeaveNotifiesPeers(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	b.send(map[string]any{"type": "leave"})
	if m := a.waitFor("peer-left"); m.ID != b.id {
		t.Fatalf("peer-left: %+v", m)
	}
}

func TestSwitchingRoomLeavesPrevious(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	b.join("cine", "bea")
	if m := a.waitFor("peer-left"); m.ID != b.id {
		t.Fatalf("peer-left: %+v", m)
	}
}

// Un join sin nombre o sin sala se ignora: el primer "joined" es el válido.
func TestJoinRejectsBlankFields(t *testing.T) {
	_, url := newTestServer(t)
	a := dial(t, url)
	a.send(map[string]any{"type": "join", "room": "general", "name": "   "})
	a.send(map[string]any{"type": "join", "room": "", "name": "ana"})
	if m := a.join("cine", "ana"); m.Room != "cine" {
		t.Fatalf("joined: %+v", m)
	}
}

func TestRoomsListsCreatedRoomsAfterFixedOnes(t *testing.T) {
	h := &hub{clients: map[string]*client{}, channels: []string{"general"}}
	h.clients["1"] = &client{id: "1", name: "zoe", room: "zzz"}
	h.clients["2"] = &client{id: "2", name: "ana", room: "aaa"}
	h.clients["3"] = &client{id: "3", name: "Bea", room: "general"}
	h.clients["4"] = &client{id: "4", name: "abel", room: "general"}
	rooms := h.roomsLocked()
	var names []string
	for _, r := range rooms {
		names = append(names, r.Name)
	}
	if got := strings.Join(names, ","); got != "general,aaa,zzz" {
		t.Fatalf("orden de salas: %s", got)
	}
	if m := rooms[0].Members; m[0].Name != "abel" || m[1].Name != "Bea" {
		t.Fatalf("miembros sin ordenar: %+v", m)
	}
}

func roomNames(rooms []roomInfo) string {
	var names []string
	for _, r := range rooms {
		names = append(names, r.Name)
	}
	return strings.Join(names, ",")
}

func TestCreatedRoomSurvivesBeingEmptied(t *testing.T) {
	h, url := newTestServer(t)
	a := dial(t, url)
	a.join("mi-sala", "ana")
	a.join("general", "ana")
	a.send(map[string]any{"type": "leave"})
	a.conn.CloseNow()

	b := dial(t, url)
	got := b.join("mi-sala", "bea")
	if got.Room != "mi-sala" || len(got.Peers) != 0 {
		t.Fatalf("joined: %+v", got)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if names := roomNames(h.roomsLocked()); names != "general,cine,mi-sala" {
		t.Fatalf("salas: %s", names)
	}
}

// Quien escribe otra capitalización acaba en la misma sala, viendo a quien ya está.
func TestRoomNamesIgnoreCase(t *testing.T) {
	h, url := newTestServer(t)
	a, b, c := dial(t, url), dial(t, url), dial(t, url)
	if got := a.join("General", "ana"); got.Room != "general" {
		t.Fatalf("sala fija: %+v", got)
	}
	if got := b.join("GENERAL", "bea"); got.Room != "general" || len(got.Peers) != 1 {
		t.Fatalf("segunda: %+v", got)
	}
	c.join("Mi-Sala", "cris")
	d := dial(t, url)
	if got := d.join("mi-sala", "dani"); got.Room != "Mi-Sala" || len(got.Peers) != 1 {
		t.Fatalf("creada: %+v", got)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if names := roomNames(h.roomsLocked()); names != "general,cine,Mi-Sala" {
		t.Fatalf("salas: %s", names)
	}
}

// Pasado el tope se puede entrar, pero la sala no se queda en la lista para siempre.
func TestCreatedRoomsAreCapped(t *testing.T) {
	h := &hub{clients: map[string]*client{}}
	for i := range maxCreatedRooms + 5 {
		h.roomForJoinLocked("sala-" + strconv.Itoa(i))
	}
	if len(h.created) != maxCreatedRooms {
		t.Fatalf("creadas: %d", len(h.created))
	}
	if got := h.roomForJoinLocked("otra"); got != "otra" {
		t.Fatalf("sobre el tope: %q", got)
	}
}

func TestClean(t *testing.T) {
	for _, tc := range []struct {
		in   string
		max  int
		want string
	}{
		{"  hola  ", 10, "hola"},
		{"abcdef", 3, "abc"},
		{"ñandú", 4, "ñand"}, // corta por runas, no por bytes
		{"🔥🔥🔥", 2, "🔥🔥"},
		{"   ", 5, ""},
	} {
		if got := clean(tc.in, tc.max); got != tc.want {
			t.Errorf("clean(%q, %d) = %q, quiero %q", tc.in, tc.max, got, tc.want)
		}
	}
}

func TestSplitList(t *testing.T) {
	if got := splitList(" a, ,b,,c "); strings.Join(got, "|") != "a|b|c" {
		t.Fatalf("splitList: %v", got)
	}
	if got := splitList(""); len(got) != 0 {
		t.Fatalf("lista vacía: %v", got)
	}
}

// Cambiar de nombre en plena sala actualiza la lista, limpia el nombre y no avisa a la sala:
// los demás lo reciben por el DataChannel, firmado por la conexión.
func TestRenameUpdatesRoomList(t *testing.T) {
	_, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("general", "ana")
	b.join("general", "bea")
	a.waitFor("peer-joined")
	a.send(map[string]any{"type": "rename", "name": "  ana‮ la grande  "})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var m testMsg
		if err := wsjson.Read(ctx, b.conn, &m); err != nil {
			t.Fatal("sin lista con el nombre nuevo:", err)
		}
		if m.Type != "rooms" {
			t.Fatalf("llegó %q a la sala", m.Type)
		}
		for _, p := range m.Rooms[0].Members {
			if p.ID == a.id && p.Name == "ana la grande" {
				return
			}
		}
	}
}

func TestRenameOutsideRoomIgnored(t *testing.T) {
	h, url := newTestServer(t)
	a := dial(t, url)
	a.send(map[string]any{"type": "rename", "name": "ana"})
	a.join("general", "bea")
	h.mu.Lock()
	defer h.mu.Unlock()
	if got := h.clients[a.id].name; got != "bea" {
		t.Fatalf("nombre: %q", got)
	}
}

func TestDeleteRoom(t *testing.T) {
	h, url := newTestServer(t)
	a, b := dial(t, url), dial(t, url)
	a.join("cine", "ana") // canal fijo
	a.join("mia", "ana")
	b.join("otra", "bea")
	b.join("general", "bea") // "otra" queda vacía
	a.send(map[string]any{"type": "delete-room", "room": "OTRA"})
	a.send(map[string]any{"type": "delete-room", "room": "cine"})
	b.join("mia", "bea")
	a.waitFor("peer-joined")
	b.send(map[string]any{"type": "delete-room", "room": "mia"}) // ana sigue dentro
	b.waitFor("room-busy")
	b.join("general", "bea")
	a.send(map[string]any{"type": "delete-room", "room": "mia"}) // sola dentro: sale y se borra
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		got, room := roomNames(h.roomsLocked()), h.clients[a.id].room
		h.mu.Unlock()
		if got == "general,cine" && room == "" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t.Fatalf("salas: %s, ana en %q", roomNames(h.roomsLocked()), h.clients[a.id].room)
}

// Tras el cambio de nombre, los datos de newchord se usan donde están; nunca se mueven.
func TestLegacyPathKeepsOldDataInPlace(t *testing.T) {
	dir := t.TempDir()
	now, old := filepath.Join(dir, "cryptopo.db"), filepath.Join(dir, "newchord.db")
	if got := legacyPath(now, old); got != now {
		t.Fatalf("sin nada: %s", got)
	}
	if err := os.WriteFile(old, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := legacyPath(now, old); got != old {
		t.Fatalf("con el antiguo: %s", got)
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("el antiguo se movió")
	}
	if err := os.WriteFile(now, []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := legacyPath(now, old); got != now {
		t.Fatalf("con los dos manda el nuevo: %s", got)
	}
}
