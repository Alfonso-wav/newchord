//go:build desktop

package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// go test -tags desktop,production -run Settings .
func TestSettingsAreSealedAndLegacyIsMigrated(t *testing.T) {
	const legacy = "clave-antigua-en-claro-suficientemente-larga"
	a := &App{dir: t.TempDir(), cfg: Settings{Port: 8090, Channels: defaultChannels}}
	b, _ := json.Marshal(map[string]any{"port": 9000, "channels": "a,b", "password": legacy})
	if err := os.WriteFile(a.settingsPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.loadSettings(); err != nil {
		t.Fatal(err)
	}
	if a.cfg.Password != legacy || a.cfg.Port != 9000 || a.cfg.Channels != "a,b" {
		t.Fatalf("ajustes: %+v", a.cfg)
	}
	disk, err := os.ReadFile(a.settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(disk), legacy) {
		t.Fatal("la clave sigue en claro en el disco")
	}

	again := &App{dir: a.dir}
	if err := again.loadSettings(); err != nil {
		t.Fatal(err)
	}
	if again.cfg.Password != legacy {
		t.Fatal("no se recupera")
	}
}

func TestSettingsReplaceWeakOrMissingKey(t *testing.T) {
	fresh := &App{dir: t.TempDir(), cfg: Settings{Port: 8090}}
	if err := fresh.loadSettings(); err != nil {
		t.Fatal(err)
	}
	if len(fresh.cfg.Password) < minSecretLen {
		t.Fatalf("sin clave generada: %q", fresh.cfg.Password)
	}

	weak := &App{dir: t.TempDir(), cfg: Settings{Port: 8090}}
	b, _ := json.Marshal(map[string]any{"password": "corta"})
	if err := os.WriteFile(weak.settingsPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := weak.loadSettings(); err != nil {
		t.Fatal(err)
	}
	if weak.cfg.Password == "corta" || len(weak.cfg.Password) < minSecretLen {
		t.Fatalf("clave débil conservada: %q", weak.cfg.Password)
	}
}

func TestOpenURLOnlyAcceptsTailscale(t *testing.T) {
	for u, want := range map[string]bool{
		"https://login.tailscale.com/f/funnel?node=1":         true,
		"https://malo.example/?https://login.tailscale.com/x": false,
		"https://login.tailscale.com/x y":                     false,
		"http://login.tailscale.com/x":                        false,
	} {
		if reSafeURL.MatchString(u) != want {
			t.Errorf("%s", u)
		}
	}
}
