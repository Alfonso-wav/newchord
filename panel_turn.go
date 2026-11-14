//go:build desktop || bindings || dev

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Settings → TURN solo tiene dos botones. Todo lo demás lo resuelve el backend: el
// integrado no necesita datos, y el propio los lee de turn.json en la carpeta del panel.

const (
	turnOffMode     = "off"
	turnBuiltinMode = "builtin"
	turnOwnMode     = "own"
)

// turnTemplate es lo que se crea la primera vez que se pulsa "TURN propio".
const turnTemplate = `{
  "_ayuda": "Rellena urls y secret (use-auth-secret de coturn) o user y pass, guarda y vuelve a pulsar TURN propio. Al leerlo, el panel cifra secret y pass para tu cuenta de Windows y los quita de aquí: para cambiarlos, vuelve a escribir el campo.",
  "urls": "",
  "secret": "",
  "user": "",
  "pass": "",
  "relayOnly": false
}
`

// turnFile es turn.json. secret y pass se escriben a mano en claro y se cambian por su
// versión cifrada con DPAPI la primera vez que se leen, como la clave en settings.json.
type turnFile struct {
	Help            string `json:"_ayuda,omitempty"`
	URLs            string `json:"urls"`
	Secret          string `json:"secret,omitempty"`
	User            string `json:"user,omitempty"`
	Pass            string `json:"pass,omitempty"`
	RelayOnly       bool   `json:"relayOnly,omitempty"`
	ProtectedSecret string `json:"protectedSecret,omitempty"`
	ProtectedPass   string `json:"protectedPass,omitempty"`
}

// editTurnFile abre turn.json para rellenarlo; los tests lo sustituyen.
var editTurnFile = func(path string) error { return exec.Command("notepad.exe", path).Start() }

// errTurnFileEdit: turn.json falta o está incompleto, y hay que abrirlo para rellenarlo.
type errTurnFileEdit struct{ msg string }

func (e errTurnFileEdit) Error() string { return e.msg }

func (a *App) turnFilePath() string { return filepath.Join(a.dir, "turn.json") }

func (a *App) loadOwnTURN() (iceConfig, error) {
	path := a.turnFilePath()
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte(turnTemplate), 0o600); err != nil {
			return iceConfig{}, err
		}
		return iceConfig{}, errTurnFileEdit{"He creado turn.json: rellénalo, guarda y vuelve a pulsar TURN propio"}
	}
	if err != nil {
		return iceConfig{}, err
	}
	var f turnFile
	if err := json.Unmarshal(b, &f); err != nil {
		return iceConfig{}, errTurnFileEdit{"turn.json no es JSON válido: " + err.Error()}
	}
	if f.Secret != "" || f.Pass != "" {
		if f.Secret != "" {
			if f.ProtectedSecret, err = seal(strings.TrimSpace(f.Secret)); err != nil {
				return iceConfig{}, err
			}
		}
		if f.Pass != "" {
			if f.ProtectedPass, err = seal(f.Pass); err != nil {
				return iceConfig{}, err
			}
		}
		f.Secret, f.Pass = "", ""
		out, err := json.MarshalIndent(f, "", "  ")
		if err != nil {
			return iceConfig{}, err
		}
		if err := os.WriteFile(path, out, 0o600); err != nil {
			return iceConfig{}, err
		}
	}
	cfg := iceConfig{STUN: defaultSTUN, TURN: f.URLs, User: strings.TrimSpace(f.User), RelayOnly: f.RelayOnly}
	// Cifrados para otra cuenta u otra máquina no se pueden leer: hay que volver a escribirlos.
	if cfg.Secret, err = unseal(f.ProtectedSecret); err != nil {
		return iceConfig{}, errTurnFileEdit{"turn.json se cifró en otra cuenta: vuelve a escribir secret o pass"}
	}
	if cfg.Pass, err = unseal(f.ProtectedPass); err != nil {
		return iceConfig{}, errTurnFileEdit{"turn.json se cifró en otra cuenta: vuelve a escribir secret o pass"}
	}
	if strings.TrimSpace(f.URLs) == "" {
		return iceConfig{}, errTurnFileEdit{"turn.json no tiene urls: rellénalo y vuelve a pulsar TURN propio"}
	}
	if err := (&hub{}).configureICE(cfg); err != nil {
		return iceConfig{}, errTurnFileEdit{"turn.json: " + err.Error()}
	}
	return cfg, nil
}

// applyTURNLocked deja el hub con el TURN que toca según el modo. Si el propio falla,
// queda solo STUN y se devuelve el motivo.
func (a *App) applyTURNLocked(h *hub) error {
	cfg, err := iceConfig{STUN: defaultSTUN}, error(nil)
	if a.cfg.TurnMode == turnOwnMode {
		own, e := a.loadOwnTURN()
		if e == nil {
			cfg = own
		} else {
			err = e
		}
	}
	h.mu.Lock()
	h.configureICE(cfg) // ya validada en loadOwnTURN
	h.mu.Unlock()

	if a.cfg.TurnMode == turnBuiltinMode {
		if a.turn == nil {
			t, e := startBuiltinTURN()
			if e != nil {
				err = fmt.Errorf("TURN integrado: %w", e)
			}
			a.turn = t
		}
	} else {
		a.stopTURNLocked()
	}
	a.pushTURNLocked(h)
	return err
}

// pushTURNLocked pasa al hub el estado del TURN integrado.
func (a *App) pushTURNLocked(h *hub) {
	if a.turn == nil {
		if a.cfg.TurnMode != turnOwnMode {
			h.setBuiltinTURN("", nil, nil)
		}
		return
	}
	var remote []string
	if a.tsDomain != "" && a.turn8443 {
		remote = remoteTURNURLs(a.tsDomain)
	}
	h.setBuiltinTURN(a.turn.secret, remote, a.turn.localURLs())
}

func (a *App) stopTURNLocked() {
	if a.turn != nil {
		a.turn.Close()
		a.turn = nil
	}
}

func (a *App) turnStateLocked() string {
	switch a.cfg.TurnMode {
	case turnOwnMode:
		return "own"
	case turnBuiltinMode:
		if a.turn != nil && a.tsDomain != "" && a.turn8443 {
			return "on"
		}
		return "local"
	default:
		return "off"
	}
}

// SetTURN es lo que hacen los botones: "builtin", "own" u "off". Se aplica en caliente a
// quien entre o reconecte después.
func (a *App) SetTURN(mode string) error {
	if mode != turnOffMode && mode != turnBuiltinMode && mode != turnOwnMode {
		return fmt.Errorf("modo TURN desconocido: %q", mode)
	}
	a.mu.Lock()
	if mode == turnOwnMode {
		if _, err := a.loadOwnTURN(); err != nil {
			a.mu.Unlock()
			var edit errTurnFileEdit
			if errors.As(err, &edit) {
				if e := editTurnFile(a.turnFilePath()); e != nil {
					return fmt.Errorf("%v (ábrelo en %s)", err, a.turnFilePath())
				}
			}
			return err
		}
	}
	next := a.cfg
	next.TurnMode = mode
	if err := a.writeSettings(next); err != nil {
		a.mu.Unlock()
		return err
	}
	a.cfg = next
	var err error
	if a.srv != nil {
		err = a.applyTURNLocked(a.hub)
	}
	a.mu.Unlock()
	log.Printf("TURN: %s", mode)
	ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	if serveErr := a.applyServe(ctx); err == nil {
		err = serveErr
	}
	return err
}
