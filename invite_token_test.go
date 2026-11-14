package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func vectorInvite(t *testing.T) string {
	t.Helper()
	k := make([]byte, 32)
	iv := make([]byte, 12)
	for i := range k {
		k[i] = byte(i)
	}
	for i := range iv {
		iv[i] = byte(100 + i)
	}
	ct, err := sealInvite(k, iv, "ID-DE-PRUEBA", "clave de prueba compartida")
	if err != nil {
		t.Fatal(err)
	}
	return ct
}

// Mismo vector en web/test/e2e.test.mjs: el navegador debe abrir lo que sella Go.
func TestInviteSealVector(t *testing.T) {
	const want = "K3e/EBzJMvseEi2dvwcL3SGta3rqHocbw7AoZDpeoVRKYw0F5RlUJzgn"
	if got := vectorInvite(t); got != want {
		t.Fatalf("sobre %s", got)
	}
}

func redeem(t *testing.T, c *testClient, id string) map[string]string {
	t.Helper()
	c.send(map[string]any{"type": "redeem", "id": id})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var raw json.RawMessage
	if err := wsjson.Read(ctx, c.conn, &raw); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	json.Unmarshal(raw, &out)
	return out
}

func serveHub(t *testing.T, h *hub) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
}

func TestInviteIsSingleUse(t *testing.T) {
	h := &hub{clients: map[string]*client{}, channels: []string{"general"}, verifier: testKey, authDelay: time.Millisecond}
	url := serveHub(t, h)
	frag, id, iv, ct, err := newInvite("clave de prueba compartida")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag, "#i="+id+".") || strings.Contains(frag, "clave") {
		t.Fatalf("fragmento %q", frag)
	}
	if err := h.addInvite(id, iv, ct, time.Minute); err != nil {
		t.Fatal(err)
	}

	a := dialRaw(t, url)
	a.waitFor("auth-required")
	if m := redeem(t, a, id); m["type"] != "invite" || m["ct"] != ct || m["iv"] != iv {
		t.Fatalf("primer canje: %v", m)
	}
	b := dialRaw(t, url)
	b.waitFor("auth-required")
	if m := redeem(t, b, id); m["type"] != "invite-failed" {
		t.Fatalf("segundo canje debía fallar: %v", m)
	}
}

func TestInviteExpiresAndPasswordChangeClearsThem(t *testing.T) {
	h := &hub{clients: map[string]*client{}, verifier: testKey, authDelay: time.Millisecond}
	if err := h.addInvite("viejo", "iv", "ct", -time.Second); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.takeInvite("viejo"); ok {
		t.Fatal("una invitación caducada no se puede canjear")
	}
	h.addInvite("vivo", "iv", "ct", time.Minute)
	h.setVerifier(oldKey)
	if _, ok := h.takeInvite("vivo"); ok {
		t.Fatal("cambiar la clave debe invalidar las invitaciones")
	}
}

func TestInviteCap(t *testing.T) {
	h := &hub{}
	for i := 0; i < maxInvites; i++ {
		if err := h.addInvite(string(rune('a'+i)), "", "", time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.addInvite("z", "", "", time.Minute); err == nil {
		t.Fatal("debe haber un máximo de pendientes")
	}
}

func TestIssueInvite(t *testing.T) {
	h := &hub{}
	link, err := h.issueInvite("https://equipo.ts.net/", "clave de prueba compartida")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(link, "https://equipo.ts.net/#i=") || strings.Contains(link, "clave") || strings.Contains(link, "#k=") {
		t.Fatalf("enlace %q", link)
	}
}

func TestWhatsAppURL(t *testing.T) {
	u := whatsAppURL("https://equipo.ts.net/#i=AAA.BBB", 24*time.Hour)
	if !strings.HasPrefix(u, "https://wa.me/?text=") || strings.ContainsAny(u[len("https://wa.me/?text="):], " +!()*~\n#") {
		t.Fatalf("url %q", u)
	}
	if !strings.Contains(u, "%23i%3DAAA.BBB") {
		t.Fatalf("el enlace debe ir codificado entero: %q", u)
	}
}
