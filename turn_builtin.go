package main

import (
	"errors"
	"net"
	"strconv"
	"sync"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// TURN integrado en el panel. Los invitados llegan por TCP+TLS a través de Funnel
// (8443) y el anfitrión por 127.0.0.1. Cada asignación retransmite desde un puerto
// UDP en 127.0.0.1, y solo puede hablar con otras asignaciones de este mismo
// servidor: el único camino que ofrece es relay ↔ relay. Así no sirve para llegar a
// otros servicios de esta máquina ni para mandar tráfico a terceros.

const (
	builtinTURNRealm = "cryptopo"
	maxBuiltinRelays = 120 // 6 personas × 5 pares × 2 sobra; cada ICE restart pide otra
)

type builtinTURN struct {
	server *turn.Server
	ln     net.Listener
	secret string

	mu     sync.Mutex
	relays map[string]bool // "127.0.0.1:puerto" de las asignaciones vivas
}

func startBuiltinTURN() (*builtinTURN, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	t := &builtinTURN{ln: ln, secret: randomHex(32), relays: map[string]bool{}}
	quiet := logging.NewDefaultLoggerFactory()
	quiet.DefaultLogLevel = logging.LogLevelDisabled
	t.server, err = turn.NewServer(turn.ServerConfig{
		Realm:         builtinTURNRealm,
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(t.secret, quiet.NewLogger("turn")),
		LoggerFactory: quiet,
		ListenerConfigs: []turn.ListenerConfig{{
			Listener:              ln,
			RelayAddressGenerator: (*relayGenerator)(t),
			PermissionHandler:     func(_ net.Addr, peer net.IP) bool { return peer.IsLoopback() },
		}},
	})
	if err != nil {
		ln.Close()
		return nil, err
	}
	return t, nil
}

func (t *builtinTURN) port() int { return t.ln.Addr().(*net.TCPAddr).Port }

// localURLs son para el navegador del anfitrión, en esta misma máquina.
func (t *builtinTURN) localURLs() []string {
	return []string{"turn:127.0.0.1:" + strconv.Itoa(t.port()) + "?transport=tcp"}
}

// remoteURLs pasan por Funnel, que termina TLS y reenvía a ln.
func remoteTURNURLs(domain string) []string {
	return []string{"turns:" + domain + ":8443?transport=tcp"}
}

func (t *builtinTURN) Close() error { return t.server.Close() }

func (t *builtinTURN) isRelay(addr net.Addr) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.relays[addr.String()]
}

type relayGenerator builtinTURN

func (g *relayGenerator) Validate() error { return nil }

func (g *relayGenerator) AllocateConn(string, int) (net.Conn, net.Addr, error) {
	return nil, nil, errors.New("sin relay TCP")
}

func (g *relayGenerator) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	t := (*builtinTURN)(g)
	t.mu.Lock()
	full := len(t.relays) >= maxBuiltinRelays
	t.mu.Unlock()
	if full {
		return nil, nil, errors.New("demasiadas asignaciones TURN")
	}
	pc, err := net.ListenPacket("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, nil, err
	}
	addr := pc.LocalAddr()
	t.mu.Lock()
	t.relays[addr.String()] = true
	t.mu.Unlock()
	return &relayConn{PacketConn: pc, t: t}, addr, nil
}

// relayConn deja pasar datagramas solo entre asignaciones de este servidor.
type relayConn struct {
	net.PacketConn
	t *builtinTURN
}

func (c *relayConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if !c.t.isRelay(addr) {
		return len(p), nil // se descarta en silencio, como haría una red con pérdidas
	}
	return c.PacketConn.WriteTo(p, addr)
}

func (c *relayConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := c.PacketConn.ReadFrom(p)
		if err != nil || c.t.isRelay(addr) {
			return n, addr, err
		}
	}
}

func (c *relayConn) Close() error {
	c.t.mu.Lock()
	delete(c.t.relays, c.LocalAddr().String())
	c.t.mu.Unlock()
	return c.PacketConn.Close()
}
