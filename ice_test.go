package main

import (
	"strings"
	"testing"
)

func TestConfigureICE(t *testing.T) {
	h := &hub{}
	if err := h.configureICE(iceConfig{STUN: defaultSTUN}); err != nil || len(h.ice) != 1 || h.turnSecret != "" {
		t.Fatalf("solo STUN: %v %+v", err, h.ice)
	}

	if err := h.configureICE(iceConfig{STUN: defaultSTUN, TURN: "turn:a:3478, turns:a:5349", User: "u", Pass: "p"}); err != nil {
		t.Fatal(err)
	}
	if len(h.ice) != 2 || h.ice[1].Username != "u" || len(h.ice[1].URLs) != 2 {
		t.Fatalf("credenciales fijas: %+v", h.ice)
	}

	if err := h.configureICE(iceConfig{STUN: defaultSTUN, TURN: "turn:a:3478", Secret: "s", RelayOnly: true}); err != nil {
		t.Fatal(err)
	}
	if len(h.ice) != 0 || !h.relayOnly {
		t.Fatalf("relay-only no debe dar STUN: %+v", h.ice)
	}
	ice := h.iceFor(&client{id: "abc"})
	if len(ice) != 1 || !strings.HasSuffix(ice[0].Username, ":abc") || ice[0].Credential == "" {
		t.Fatalf("credenciales temporales: %+v", ice)
	}

	for name, bad := range map[string]iceConfig{
		"esquema":        {TURN: "stun:a:3478", Secret: "s"},
		"sin secreto":    {TURN: "turn:a:3478", User: "u"},
		"relay sin TURN": {RelayOnly: true},
	} {
		if err := (&hub{}).configureICE(bad); err == nil {
			t.Errorf("%s: aceptado", name)
		}
	}
}
