package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Invitaciones de un solo uso. El enlace es /#i=<id>.<k>: el navegador no envía el fragmento.
//
//	id  16 bytes aleatorios: lo único que ve el servidor; sirve para canjear.
//	k   32 bytes aleatorios: clave AES-GCM que nunca sale del enlace.
//
// El anfitrión (que conoce la clave de sala) sella la clave con k y deja el sobre en el servidor.
// El invitado lo canjea una vez, lo abre con k y sigue el reto de siempre. Pasado el canje, o la
// caducidad, el enlace no vale para nada: ya no es la clave de sala, que era permanente.
const (
	inviteTTL      = 24 * time.Hour
	maxInvites     = 20
	inviteContext  = "newchord-invite-v1|"
	inviteIDBytes  = 16
	inviteKeyBytes = 32
)

type invite struct {
	iv, ct string // base64 estándar, como el resto de sobres
	exp    time.Time
}

var errTooManyInvites = errors.New("demasiadas invitaciones pendientes")

// sealInvite es determinista dado iv, para fijar un vector común con web/test/e2e.test.mjs.
func sealInvite(k, iv []byte, id, secret string) (string, error) {
	block, err := aes.NewCipher(k)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(iv) != gcm.NonceSize() {
		return "", errors.New("iv de tamaño incorrecto")
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nil, iv, []byte(secret), []byte(inviteContext+id))), nil
}

// newInvite crea el enlace (fragmento) y el sobre. El sobre se registra en el hub con addInvite.
func newInvite(secret string) (fragment string, id string, iv, ct string, err error) {
	raw := make([]byte, inviteIDBytes+inviteKeyBytes+12)
	if _, err = rand.Read(raw); err != nil {
		return
	}
	idb, k, ivb := raw[:inviteIDBytes], raw[inviteIDBytes:inviteIDBytes+inviteKeyBytes], raw[inviteIDBytes+inviteKeyBytes:]
	id = base64.RawURLEncoding.EncodeToString(idb)
	if ct, err = sealInvite(k, ivb, id, secret); err != nil {
		return
	}
	iv = base64.StdEncoding.EncodeToString(ivb)
	fragment = "#i=" + id + "." + base64.RawURLEncoding.EncodeToString(k)
	return
}

// addInvite registra un sobre. Las caducadas se limpian aquí y al canjear.
func (h *hub) addInvite(id, iv, ct string, ttl time.Duration) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeInvitesLocked()
	if len(h.invites) >= maxInvites {
		return errTooManyInvites
	}
	if h.invites == nil {
		h.invites = map[string]invite{}
	}
	h.invites[id] = invite{iv: iv, ct: ct, exp: time.Now().Add(ttl)}
	return nil
}

// takeInvite entrega el sobre y lo borra: un segundo canje, o uno caducado, no obtiene nada.
func (h *hub) takeInvite(id string) (invite, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeInvitesLocked()
	inv, ok := h.invites[id]
	delete(h.invites, id)
	return inv, ok
}

func (h *hub) purgeInvitesLocked() {
	now := time.Now()
	for id, inv := range h.invites {
		if now.After(inv.exp) {
			delete(h.invites, id)
		}
	}
}

// issueInvite crea una invitación vigente inviteTTL y devuelve el enlace completo.
func (h *hub) issueInvite(base, secret string) (string, error) {
	frag, id, iv, ct, err := newInvite(secret)
	if err != nil {
		return "", err
	}
	if err := h.addInvite(id, iv, ct, inviteTTL); err != nil {
		return "", err
	}
	return strings.TrimRight(base, "/") + "/" + frag, nil
}

// whatsAppURL abre WhatsApp con el mensaje escrito. El fragmento del enlace va codificado entero
// dentro de text=, así que wa.me no lo ve como suyo y llega intacto. WhatsApp no consume la
// invitación al generar la vista previa: el id vive tras el #, que ningún servidor recibe.
func whatsAppURL(link string, ttl time.Duration) string {
	msg := fmt.Sprintf("Entra a la llamada de cryptopo con este enlace (vale una vez y %d horas):\n%s", int(ttl.Hours()), link)
	return "https://wa.me/?text=" + strings.ReplaceAll(url.QueryEscape(msg), "+", "%20")
}
