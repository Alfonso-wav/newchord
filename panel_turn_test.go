//go:build desktop

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func startedPanel(t *testing.T) *App {
	t.Helper()
	a := &App{dir: t.TempDir(), funnelMode: "off", cfg: Settings{Port: 18093, Channels: defaultChannels}}
	if err := a.loadSettings(); err != nil {
		t.Fatal(err)
	}
	var err error
	if a.st, err = openStore(filepath.Join(a.dir, "t.db")); err != nil {
		t.Fatal(err)
	}
	if err := a.StartServer(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.StopServer(); a.st.Close() })
	return a
}

func iceOf(a *App, c *client) []iceServer {
	a.hub.mu.Lock()
	defer a.hub.mu.Unlock()
	return a.hub.iceFor(c)
}

var (
	origEdit    = editTurnFile
	hostClient  = &client{id: "h", net: netInfo{ip: "127.0.0.1"}}
	guestClient = &client{id: "g", net: netInfo{ip: "127.0.0.1", forwarded: "203.0.113.5"}}
)

func TestBuiltinTURNButton(t *testing.T) {
	a := startedPanel(t)
	if err := a.SetTURN(turnBuiltinMode); err != nil {
		t.Fatal(err)
	}
	if a.turn == nil || a.State().Turn != "local" {
		t.Fatalf("encendido sin Funnel: %q", a.State().Turn)
	}
	if host := iceOf(a, hostClient); len(host) != 2 || !strings.HasPrefix(host[1].URLs[0], "turn:127.0.0.1:") {
		t.Fatalf("el anfitrión debe recibir el TURN local: %+v", host)
	}
	if guest := iceOf(a, guestClient); len(guest) != 1 {
		t.Fatalf("sin Funnel, el invitado solo recibe STUN: %+v", guest)
	}
	again := &App{dir: a.dir}
	if err := again.loadSettings(); err != nil || again.cfg.TurnMode != turnBuiltinMode {
		t.Fatalf("no se guarda el botón: %v %q", err, again.cfg.TurnMode)
	}

	if err := a.SetTURN(turnOffMode); err != nil {
		t.Fatal(err)
	}
	if a.turn != nil || len(iceOf(a, hostClient)) != 1 || a.State().Turn != "off" {
		t.Fatal("no se apaga")
	}
}

func TestOwnTURNFileIsCreatedFilledAndSealed(t *testing.T) {
	a := startedPanel(t)
	var opened []string
	editTurnFile = func(p string) error { opened = append(opened, p); return nil }
	t.Cleanup(func() { editTurnFile = origEdit })

	// 1. Sin turn.json: se crea la plantilla, se abre y el botón no se activa.
	err := a.SetTURN(turnOwnMode)
	if err == nil || len(opened) != 1 || a.State().Turn != "off" {
		t.Fatalf("primera pulsación: %v %v %q", err, opened, a.State().Turn)
	}
	if _, err := os.Stat(a.turnFilePath()); err != nil {
		t.Fatal("no se ha creado turn.json")
	}
	// 2. Sin rellenar: vuelve a abrirlo.
	if err := a.SetTURN(turnOwnMode); err == nil || len(opened) != 2 {
		t.Fatalf("plantilla vacía aceptada: %v", err)
	}

	// 3. Relleno a mano, en claro.
	f := map[string]any{"urls": "turn:mi.host:3478", "secret": "secreto-turn-en-claro", "relayOnly": true}
	b, _ := json.Marshal(f)
	if err := os.WriteFile(a.turnFilePath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.SetTURN(turnOwnMode); err != nil {
		t.Fatal(err)
	}
	if a.State().Turn != "own" || a.turn != nil {
		t.Fatalf("estado: %q", a.State().Turn)
	}
	disk, _ := os.ReadFile(a.turnFilePath())
	if strings.Contains(string(disk), "secreto-turn-en-claro") || !strings.Contains(string(disk), "protectedSecret") {
		t.Fatalf("el secreto sigue en claro: %s", disk)
	}
	guest := iceOf(a, guestClient)
	if len(guest) != 1 || guest[0].URLs[0] != "turn:mi.host:3478" || guest[0].Credential == "" {
		t.Fatalf("relay-only con credenciales temporales: %+v", guest)
	}

	// 4. Se lee igual tras reiniciar el server, ya cifrado.
	a.StopServer()
	if err := a.StartServer(); err != nil {
		t.Fatal(err)
	}
	if guest := iceOf(a, guestClient); len(guest) != 1 || guest[0].URLs[0] != "turn:mi.host:3478" {
		t.Fatalf("tras reiniciar: %+v %q", guest, a.State().Message)
	}

	// 5. Activar el integrado apaga el propio.
	if err := a.SetTURN(turnBuiltinMode); err != nil {
		t.Fatal(err)
	}
	if a.State().Turn != "local" || iceOf(a, guestClient)[0].URLs[0] == "turn:mi.host:3478" {
		t.Fatal("el propio sigue activo")
	}
}

func TestOwnTURNBrokenFileDoesNotStopServer(t *testing.T) {
	a := startedPanel(t)
	editTurnFile = func(string) error { return nil }
	t.Cleanup(func() { editTurnFile = origEdit })
	os.WriteFile(a.turnFilePath(), []byte(`{"urls":"turn:a:3478","secret":"s"}`), 0o600)
	if err := a.SetTURN(turnOwnMode); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(a.turnFilePath(), []byte(`{roto`), 0o600)
	a.StopServer()
	if err := a.StartServer(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(a.State().Message, "sin TURN") || len(iceOf(a, guestClient)) != 1 {
		t.Fatalf("debe arrancar con solo STUN y avisar: %q", a.State().Message)
	}
}

func TestEmbeddedPanelHasNoLogsOrState(t *testing.T) {
	if bad := embeddedLeaks(panelAssets); len(bad) > 0 {
		t.Fatalf("el exe llevaría ficheros que no son el panel: %v", bad)
	}
}
