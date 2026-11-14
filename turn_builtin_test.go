package main

import (
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// turnClient se conecta por TCP, como un invitado tras Funnel, y pide una asignación.
func turnClient(t *testing.T, srv *builtinTURN, id string) (*turn.Client, net.PacketConn) {
	t.Helper()
	conn, err := net.Dial("tcp", srv.ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	user, pass := turnCredentials(srv.secret, id, time.Hour, time.Now())
	c, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: srv.ln.Addr().String(), TURNServerAddr: srv.ln.Addr().String(),
		Conn: turn.NewSTUNConn(conn), Username: user, Password: pass, Realm: builtinTURNRealm,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Listen(); err != nil {
		t.Fatal(err)
	}
	relay, err := c.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { relay.Close(); c.Close() })
	return c, relay
}

func readWithin(pc net.PacketConn, d time.Duration) (string, net.Addr, error) {
	buf := make([]byte, 1500)
	pc.SetReadDeadline(time.Now().Add(d))
	n, addr, err := pc.ReadFrom(buf)
	return string(buf[:n]), addr, err
}

func TestBuiltinTURNRelaysBetweenAllocations(t *testing.T) {
	srv, err := startBuiltinTURN()
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	_, a := turnClient(t, srv, "a")
	_, b := turnClient(t, srv, "b")
	if !a.LocalAddr().(*net.UDPAddr).IP.IsLoopback() {
		t.Fatalf("la asignación debe vivir en 127.0.0.1: %v", a.LocalAddr())
	}
	// Cada lado necesita permiso para el otro: ICE manda comprobaciones desde los dos.
	b.WriteTo([]byte("permiso"), a.LocalAddr())
	var got string
	for i := 0; i < 20 && (got == "" || got == "permiso"); i++ {
		if _, err := a.WriteTo([]byte("hola"), b.LocalAddr()); err != nil {
			t.Fatal(err)
		}
		got, _, _ = readWithin(b, 200*time.Millisecond)
	}
	if got != "hola" {
		t.Fatalf("relay a relay no llega: %q", got)
	}

	if _, err := b.WriteTo([]byte("vuelta"), a.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	got = "permiso"
	var err2 error
	for got == "permiso" && err2 == nil {
		got, _, err2 = readWithin(a, 2*time.Second)
	}
	if got != "vuelta" {
		t.Fatalf("vuelta: %q %v", got, err2)
	}
}

func TestBuiltinTURNCannotReachOtherServices(t *testing.T) {
	srv, err := startBuiltinTURN()
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	// Un servicio UDP cualquiera en esta máquina, que no es una asignación.
	victim, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer victim.Close()

	_, a := turnClient(t, srv, "a")
	for i := 0; i < 5; i++ {
		a.WriteTo([]byte("ataque"), victim.LocalAddr())
	}
	if got, _, err := readWithin(victim, 500*time.Millisecond); err == nil {
		t.Fatalf("el TURN ha llegado a otro servicio: %q", got)
	}

	// Y lo que mande ese servicio a la asignación tampoco entra.
	victim.WriteTo([]byte("inyección"), a.LocalAddr())
	if got, _, err := readWithin(a, 500*time.Millisecond); err == nil {
		t.Fatalf("la asignación acepta tráfico ajeno: %q", got)
	}
}

func TestBuiltinTURNRejectsBadCredentials(t *testing.T) {
	srv, err := startBuiltinTURN()
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	user, pass := turnCredentials("otro-secreto", "x", time.Hour, time.Now())
	c, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: srv.ln.Addr().String(), TURNServerAddr: srv.ln.Addr().String(),
		Conn: turn.NewSTUNConn(conn), Username: user, Password: pass, Realm: builtinTURNRealm,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Listen(); err != nil {
		t.Fatal(err)
	}
	if relay, err := c.Allocate(); err == nil {
		relay.Close()
		t.Fatal("asigna con un secreto equivocado")
	}
}

func TestICEForLocalHostGetsLoopbackTURN(t *testing.T) {
	h := &hub{}
	h.setBuiltinTURN("s", []string{"turns:x.ts.net:8443?transport=tcp"}, []string{"turn:127.0.0.1:1?transport=tcp"})
	local := h.iceFor(&client{id: "a", net: netInfo{ip: "127.0.0.1"}})
	guest := h.iceFor(&client{id: "b", net: netInfo{ip: "127.0.0.1", forwarded: "203.0.113.5"}})
	if len(local) != 1 || local[0].URLs[0] != "turn:127.0.0.1:1?transport=tcp" {
		t.Fatalf("anfitrión: %+v", local)
	}
	if len(guest) != 1 || guest[0].URLs[0] != "turns:x.ts.net:8443?transport=tcp" {
		t.Fatalf("invitado: %+v", guest)
	}

	h.setBuiltinTURN("s", nil, []string{"turn:127.0.0.1:1?transport=tcp"}) // sin Funnel todavía
	if got := h.iceFor(&client{id: "b", net: netInfo{ip: "127.0.0.1", forwarded: "203.0.113.5"}}); len(got) != 0 {
		t.Fatalf("sin Funnel, el invitado no debe recibir TURN: %+v", got)
	}
}
