// cryptopo: servidor de señalización mínimo. Solo reenvía mensajes opacos entre
// peers de la misma sala; el audio/vídeo va directo P2P por WebRTC y la señalización
// va cifrada entre navegadores (web/src/e2e.ts).
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

//go:embed all:web/dist
var dist embed.FS

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type roomInfo struct {
	Name    string     `json:"name"`
	Members []peerInfo `json:"members"`
	Fixed   bool       `json:"fixed,omitempty"` // de -channels: no se puede borrar
}

type inMsg struct {
	Type string          `json:"type"`
	Room string          `json:"room,omitempty"`
	Name string          `json:"name,omitempty"`
	To   string          `json:"to,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`

	Proof string `json:"proof,omitempty"`
	ID    string `json:"id,omitempty"` // redeem: id de la invitación
}

type client struct {
	id   string
	name string
	room string
	out  chan []byte
	conn *websocket.Conn

	session string
	net     netInfo

	tokens   float64 // cubo de mensajes: un cliente autenticado tampoco puede saturar al resto
	lastFill time.Time
}

type hub struct {
	mu       sync.Mutex
	clients  map[string]*client
	channels []string
	ice      []iceServer
	origins  []string
	store    *store
	created  []string // salas creadas por usuarios; duran lo que dure el server

	verifier  []byte     // vacío: sin autenticación, solo en tests; main exige siempre una clave
	authGate  sync.Mutex // serializa los fallos: limita los intentos a uno por authDelay en todo el servidor
	authDelay time.Duration
	pending   map[string]int    // conexiones sin autenticar por IP
	invites   map[string]invite // invitaciones de un solo uso, por id

	turnSecret string
	turnURLs   []string
	turnLocal  []string // TURN integrado del panel: el navegador del anfitrión entra por 127.0.0.1
	turnTTL    time.Duration
	relayOnly  bool
	maxRoom    int
}

const (
	authTimeout     = 30 * time.Second
	maxAuthFails    = 5
	maxPreAuthMsgs  = 16
	maxRedeems      = 3
	maxPending      = 64
	maxPendingPerIP = 8
	maxClients      = 64
	defaultMaxRoom  = 6
	maxCreatedRooms = 50
	preAuthLimit    = 4096
	signalLimit     = 256 << 10 // un SDP cifrado cabe de sobra
	bucketSize      = 400.0
	bucketRefill    = 100.0 // por segundo
	costSignal      = 1.0
	costRoomChange  = 20.0 // difunde a todos y escribe en disco
)

// setVerifier echa a todos: reconectan solos y vuelven a autenticarse, que es lo
// que hace efectivo el cambio con quien ya estaba dentro.
func (h *hub) setVerifier(v []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if string(v) == string(h.verifier) {
		return
	}
	h.verifier = v
	h.invites = nil // llevan la clave anterior
	h.closeAllLocked("password-changed")
}

func (h *hub) closeAllLocked(reason string) {
	for _, c := range h.clients {
		h.leaveLocked(c, reason)
		go c.conn.Close(websocket.StatusNormalClosure, reason)
	}
}

// admitLocked va en la misma sección crítica que comprobar la prueba: un cambio de
// clave no puede colarse entre ambas y dejar dentro a quien usó la anterior.
func (h *hub) admitLocked(c *client) bool {
	if len(h.clients) >= maxClients {
		return false
	}
	h.clients[c.id] = c
	h.sendLocked(c, map[string]any{"type": "hello", "id": c.id, "ice": h.iceFor(c), "relay": h.relayOnly, "rooms": h.roomsLocked()})
	return true
}

// iceConfig es lo que llega de los flags o de Settings del panel. Con Secret, cada
// cliente recibe credenciales TURN que caducan (use-auth-secret de coturn).
type iceConfig struct {
	STUN, TURN, Secret, User, Pass string
	RelayOnly                      bool
	Builtin                        bool // el TURN integrado se configura aparte, con setBuiltinTURN
}

// configureICE se llama antes de servir: ice nunca queda nil, porque "ice":null hace
// lanzar a new RTCPeerConnection en el cliente.
func (h *hub) configureICE(c iceConfig) error {
	turn := splitList(c.TURN)
	for _, u := range turn {
		if !strings.HasPrefix(u, "turn:") && !strings.HasPrefix(u, "turns:") {
			return fmt.Errorf("%q no es una URL TURN: empieza por turn: o turns:", u)
		}
	}
	if len(turn) > 0 && c.Secret == "" && (c.User == "" || c.Pass == "") {
		return errors.New("TURN necesita un secreto, o usuario y contraseña")
	}
	if len(turn) > 0 && c.Builtin {
		return errors.New("el TURN integrado y uno propio no van juntos")
	}
	if len(turn) == 0 && c.RelayOnly && !c.Builtin {
		return errors.New("relay-only necesita un servidor TURN")
	}
	h.ice, h.turnSecret, h.turnURLs, h.turnLocal, h.relayOnly = []iceServer{}, "", nil, nil, c.RelayOnly
	if s := splitList(c.STUN); len(s) > 0 && !c.RelayOnly {
		h.ice = append(h.ice, iceServer{URLs: s})
	}
	switch {
	case len(turn) == 0:
	case c.Secret != "":
		h.turnSecret, h.turnURLs = c.Secret, turn
	default:
		h.ice = append(h.ice, iceServer{URLs: turn, Username: c.User, Credential: c.Pass})
	}
	return nil
}

func (h *hub) iceFor(c *client) []iceServer {
	urls := h.turnURLs
	if len(h.turnLocal) > 0 && c.net.forwarded == "" && isLoopbackAddr(net.JoinHostPort(c.net.ip, "0")) {
		urls = h.turnLocal
	}
	if h.turnSecret == "" || len(urls) == 0 {
		return h.ice
	}
	ttl := h.turnTTL
	if ttl == 0 {
		ttl = 12 * time.Hour
	}
	user, cred := turnCredentials(h.turnSecret, c.id, ttl, time.Now())
	return append(append([]iceServer{}, h.ice...), iceServer{URLs: urls, Username: user, Credential: cred})
}

// setBuiltinTURN cambia el TURN integrado en caliente; vale para quien entre o
// reconecte después. remote queda vacío mientras no haya Funnel. Sin secreto, se quita.
func (h *hub) setBuiltinTURN(secret string, remote, local []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.turnSecret, h.turnURLs, h.turnLocal = secret, remote, local
}

// authenticate retiene la conexión hasta recibir una prueba válida del reto. Hasta
// entonces el cliente no está en h.clients: no recibe hello (con credenciales TURN)
// ni salas. El reintento va por la misma conexión; agotar el tiempo o los intentos
// la cierra. Al volver true el cliente ya está admitido.
func (h *hub) authenticate(ctx context.Context, c *client) bool {
	h.mu.Lock()
	if len(h.verifier) == 0 {
		defer h.mu.Unlock()
		return h.admitLocked(c)
	}
	nonce := randomHex(32)
	h.sendLocked(c, map[string]any{"type": "auth-required", "nonce": nonce})
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()
	for fails, other, redeems := 0, 0, 0; fails < maxAuthFails && other < maxPreAuthMsgs; {
		var m inMsg
		if err := wsjson.Read(ctx, c.conn, &m); err != nil {
			return false
		}
		if m.Type == "redeem" && redeems < maxRedeems {
			redeems++
			if inv, ok := h.takeInvite(m.ID); ok {
				h.mu.Lock()
				h.sendLocked(c, map[string]any{"type": "invite", "iv": inv.iv, "ct": inv.ct})
				h.mu.Unlock()
				continue
			}
			h.store.event("invite-failed", c.id, "", c.net, "")
			// Mismo freno que una clave errónea: no se pueden probar ids a ritmo libre.
			h.authGate.Lock()
			time.Sleep(h.authDelay)
			h.authGate.Unlock()
			h.mu.Lock()
			h.sendLocked(c, map[string]any{"type": "invite-failed"})
			h.mu.Unlock()
			continue
		}
		if m.Type != "auth" {
			other++
			continue
		}
		h.mu.Lock()
		ok := validProof(h.verifier, nonce, m.Proof)
		admitted := ok && h.admitLocked(c)
		h.mu.Unlock()
		if ok {
			return admitted
		}
		fails++
		h.store.event("auth-failed", c.id, "", c.net, "")
		h.authGate.Lock()
		time.Sleep(h.authDelay)
		h.authGate.Unlock()
		nonce = randomHex(32)
		// Directo y no por c.out: si era el último intento, la conexión se cierra enseguida
		// y el navegador necesita este aviso para olvidar la clave.
		if err := wsjson.Write(ctx, c.conn, map[string]any{"type": "auth-failed", "nonce": nonce}); err != nil {
			return false
		}
	}
	return false
}

// acquirePending limita las conexiones que aún no han demostrado nada.
func (h *hub) acquirePending(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending == nil {
		h.pending = map[string]int{}
	}
	total := 0
	for _, n := range h.pending {
		total += n
	}
	if total >= maxPending || h.pending[ip] >= maxPendingPerIP {
		return false
	}
	h.pending[ip]++
	return true
}

func (h *hub) releasePending(ip string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending[ip]--; h.pending[ip] <= 0 {
		delete(h.pending, ip)
	}
}

// allow descuenta del cubo del cliente; solo lo llama su goroutine de lectura.
func (c *client) allow(cost float64) bool {
	now := time.Now()
	if c.lastFill.IsZero() {
		c.tokens = bucketSize
	} else {
		c.tokens = min(bucketSize, c.tokens+now.Sub(c.lastFill).Seconds()*bucketRefill)
	}
	c.lastFill = now
	if c.tokens < cost {
		return false
	}
	c.tokens -= cost
	return true
}

func newID() string { return randomHex(16) }

// clean quita también controles y formato (bidi, anchura cero): sin ellos no se puede
// fabricar un nombre que se vea igual que el de otro o que invierta el texto.
func clean(s string, max int) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	for utf8.RuneCountInString(s) > max {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	return s
}

// sendLocked encola sin bloquear; un cliente que no lee se desconecta.
func (h *hub) sendLocked(c *client, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.out <- b:
	default:
		go c.conn.Close(websocket.StatusPolicyViolation, "slow consumer")
	}
}

// roomForJoinLocked devuelve el nombre ya existente aunque difiera en mayúsculas,
// y recuerda las salas nuevas para que no desaparezcan al vaciarse. Pasado el
// tope se puede entrar igual, pero la sala vive solo mientras tenga gente.
func (h *hub) roomForJoinLocked(room string) string {
	for _, name := range h.channels {
		if strings.EqualFold(name, room) {
			return name
		}
	}
	for _, name := range h.created {
		if strings.EqualFold(name, room) {
			return name
		}
	}
	for _, c := range h.clients {
		if strings.EqualFold(c.room, room) {
			return c.room
		}
	}
	if len(h.created) < maxCreatedRooms {
		h.created = append(h.created, room)
	}
	return room
}

// deleteRoomLocked borra una sala creada por usuarios. Los canales fijos no se tocan, y una
// sala con alguien más dentro tampoco: borrarla no es forma de echar a nadie. Si quien la
// borra estaba dentro, sale.
func (h *hub) deleteRoomLocked(c *client, room string) {
	i := slices.IndexFunc(h.created, func(n string) bool { return strings.EqualFold(n, room) })
	if i < 0 {
		return
	}
	name := h.created[i]
	for _, o := range h.clients {
		if o != c && o.room == name {
			h.sendLocked(c, map[string]any{"type": "room-busy", "room": name})
			return
		}
	}
	if c.room == name {
		h.leaveLocked(c, "delete")
	}
	h.created = slices.Delete(h.created, i, i+1)
	h.store.event("delete-room", c.id, c.name, c.net, name)
	h.broadcastRoomsLocked()
}

func (h *hub) roomsLocked() []roomInfo {
	byRoom := map[string][]peerInfo{}
	for _, name := range h.created {
		byRoom[name] = nil
	}
	for _, c := range h.clients {
		if c.room != "" {
			byRoom[c.room] = append(byRoom[c.room], peerInfo{c.id, c.name})
		}
	}
	var out []roomInfo
	seen := map[string]bool{}
	for _, name := range h.channels {
		seen[name] = true
		out = append(out, roomInfo{name, sortMembers(byRoom[name]), true})
	}
	var extra []string
	for name := range byRoom {
		if !seen[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		out = append(out, roomInfo{name, sortMembers(byRoom[name]), false})
	}
	return out
}

func sortMembers(m []peerInfo) []peerInfo {
	if m == nil {
		return []peerInfo{}
	}
	sort.Slice(m, func(i, j int) bool { return strings.ToLower(m[i].Name) < strings.ToLower(m[j].Name) })
	return m
}

func (h *hub) broadcastRoomsLocked() {
	msg := map[string]any{"type": "rooms", "rooms": h.roomsLocked()}
	for _, c := range h.clients {
		h.sendLocked(c, msg)
	}
}

func (h *hub) leaveLocked(c *client, reason string) {
	if c.room == "" {
		return
	}
	h.store.sessionEnd(c.session, reason)
	for _, o := range h.clients {
		if o != c && o.room == c.room {
			h.sendLocked(o, map[string]any{"type": "peer-left", "id": c.id})
		}
	}
	c.room = ""
}

func (h *hub) roomFullLocked(c *client, room string) bool {
	limit := h.maxRoom
	if limit == 0 {
		limit = defaultMaxRoom
	}
	n := 0
	for _, o := range h.clients {
		if o != c && strings.EqualFold(o.room, room) {
			n++
		}
	}
	return n >= limit
}

func (h *hub) handle(c *client, m inMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch m.Type {
	case "join":
		room, name := clean(m.Room, 40), clean(m.Name, 32)
		if room == "" || name == "" {
			return
		}
		if h.roomFullLocked(c, room) {
			h.sendLocked(c, map[string]any{"type": "room-full", "room": room})
			return
		}
		h.leaveLocked(c, "switch")
		room = h.roomForJoinLocked(room)
		c.name, c.room, c.session = name, room, newID()
		h.store.sessionStart(c.session, c.id, name, room, c.net)
		peers := []peerInfo{}
		for _, o := range h.clients {
			if o != c && o.room == room {
				peers = append(peers, peerInfo{o.id, o.name})
				h.sendLocked(o, map[string]any{"type": "peer-joined", "id": c.id, "name": c.name})
			}
		}
		h.sendLocked(c, map[string]any{"type": "joined", "room": room, "peers": peers})
		h.broadcastRoomsLocked()
	case "rename":
		// Solo para la lista de salas: los demás de la sala lo saben por el DataChannel,
		// donde el nombre lo respalda la identidad del dispositivo, no el servidor.
		name := clean(m.Name, 32)
		if c.room == "" || name == "" || name == c.name {
			return
		}
		h.store.event("rename", c.id, name, c.net, c.name)
		c.name = name
		h.broadcastRoomsLocked()
	case "leave":
		h.leaveLocked(c, "leave")
		h.broadcastRoomsLocked()
	case "delete-room":
		h.deleteRoomLocked(c, clean(m.Room, 40))
	case "signal":
		t := h.clients[m.To]
		if t != nil && c.room != "" && t.room == c.room {
			h.sendLocked(t, map[string]any{"type": "signal", "from": c.id, "data": m.Data})
		}
	}
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	info := netInfoFrom(r)
	ip := info.clientIP()
	if !h.acquirePending(ip) {
		http.Error(w, "demasiadas conexiones", http.StatusTooManyRequests)
		return
	}
	pending := true
	release := func() {
		if pending {
			pending = false
			h.releasePending(ip)
		}
	}
	defer release()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins})
	if err != nil {
		h.store.event("ws-rejected", "", "", info, clean(r.Header.Get("Origin"), 200))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	c := &client{id: newID(), out: make(chan []byte, 64), conn: conn, net: info}
	go writeLoop(ctx, c)
	go pingLoop(ctx, c)
	h.store.event("connect", c.id, "", info, "")

	conn.SetReadLimit(preAuthLimit)
	if !h.authenticate(ctx, c) {
		h.store.event("disconnect", c.id, "", info, "")
		conn.CloseNow()
		return
	}
	release()
	conn.SetReadLimit(signalLimit)

	defer func() {
		h.mu.Lock()
		h.leaveLocked(c, "disconnect")
		delete(h.clients, c.id)
		h.broadcastRoomsLocked()
		h.store.event("disconnect", c.id, c.name, info, "")
		h.mu.Unlock()
		conn.CloseNow()
	}()

	for {
		var m inMsg
		if err := wsjson.Read(ctx, conn, &m); err != nil {
			return
		}
		cost := costRoomChange
		if m.Type == "signal" {
			cost = costSignal
		}
		if !c.allow(cost) {
			conn.Close(websocket.StatusPolicyViolation, "rate limit")
			return
		}
		h.handle(c, m)
	}
}

func writeLoop(ctx context.Context, c *client) {
	for {
		select {
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.conn.CloseNow()
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// Va aparte porque Ping espera al pong: en writeLoop bloquearía los mensajes. Un
// pong que no llega cierra: si no, la conexión muerta seguiría en la lista de la sala.
func pingLoop(ctx context.Context, c *client) {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				c.conn.CloseNow()
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

const (
	defaultChannels = "general,cine,juegos,chill"
	defaultSTUN     = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
	defaultJoinAddr = "127.0.0.1:8091"
	defaultDB       = "cryptopo.db"
)

// El CSP deja fuera scripts y estilos inline, y orígenes ajenos: un fallo de escape
// en la interfaz no se convierte en robo de claves ni en micro abierto hacia fuera.
// 'wasm-unsafe-eval' solo permite compilar WebAssembly (SQLite del archivo local y Whisper del
// dictado), no eval de JS; blob: en img-src son las imágenes del chat ya decodificadas aquí.
const contentPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; " +
	"media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
	"require-trusted-types-for 'script'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", contentPolicy)
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		hd.Set("Cross-Origin-Resource-Policy", "same-origin")
		hd.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), autoplay=(self), clipboard-write=(self), geolocation=(), usb=(), payment=()")
		hd.Set("Cache-Control", "no-cache")
		if r.TLS != nil {
			hd.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// Los ficheros del dictado (/stt/, ~100 MB) pueden tardar más que WriteTimeout por un túnel lento.
const largeWriteTimeout = 15 * time.Minute

// staticFiles no lista directorios: solo sirve lo que la página pide por su nombre. Cada fichero
// lleva un ETag de su contenido: con no-cache, el navegador revalida sin volver a bajarlo.
func staticFiles(static fs.FS) http.Handler {
	files := http.FileServer(http.FS(static))
	var etags sync.Map
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/stt/") {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(largeWriteTimeout))
		}
		if tag := staticETag(static, &etags, r.URL.Path); tag != "" {
			w.Header().Set("ETag", tag)
		}
		files.ServeHTTP(w, r)
	})
}

type etagEntry struct {
	mod  time.Time
	size int64
	tag  string
}

// El ETag se calcula una vez por versión del fichero: con -static cambia al recompilar.
func staticETag(static fs.FS, cache *sync.Map, urlPath string) string {
	name := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
	if name == "" {
		name = "index.html"
	}
	f, err := static.Open(name)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return ""
	}
	if v, ok := cache.Load(name); ok {
		if e := v.(etagEntry); e.mod.Equal(st.ModTime()) && e.size == st.Size() {
			return e.tag
		}
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	tag := `"` + hex.EncodeToString(sum.Sum(nil)[:12]) + `"`
	cache.Store(name, etagEntry{st.ModTime(), st.Size(), tag})
	return tag
}

func newMux(h *hub, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.Handle("/", staticFiles(static))
	return securityHeaders(mux)
}

func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS13},
	}
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// newJoinHandler sirve la interfaz incluida en este binario y reenvía solo /ws al
// servidor remoto. Así el código que maneja las claves no viene del servidor, que
// ya no puede inyectar nada y solo ve señalización cifrada.
func newJoinHandler(target *url.URL, static fs.FS) http.Handler {
	origin := target.Scheme + "://" + target.Host
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			r.Out.Header.Set("Origin", origin)
		},
		ErrorLog: log.New(io.Discard, "", 0),
	}
	mux := http.NewServeMux()
	mux.Handle("/", staticFiles(static))
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "origen no permitido", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	// Comprobar Host corta el DNS rebinding: otra web apuntando su dominio a 127.0.0.1.
	return securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackAddr(r.Host) {
			http.Error(w, "host no permitido", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	}))
}

func parseJoinTarget(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	if u.Host == "" || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackAddr(u.Host))) {
		return nil, errors.New("-join necesita una URL https://")
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

// serverVerifier saca la clave de una sola fuente. -password y -verifier en la línea
// de órdenes quedan en el historial y la lista de procesos: mejor fichero o entorno.
func serverVerifier(password, passwordFile, verifier string) ([]byte, error) {
	if verifier == "" {
		verifier = getenv("VERIFIER")
	}
	if verifier != "" {
		v, err := hex.DecodeString(strings.TrimSpace(verifier))
		if err != nil || len(v) != 32 {
			return nil, errors.New("el verificador deben ser 64 caracteres hexadecimales")
		}
		return v, nil
	}
	if passwordFile != "" {
		b, err := os.ReadFile(passwordFile)
		if err != nil {
			return nil, err
		}
		password = string(b)
	}
	if password == "" {
		password = getenv("PASSWORD")
	}
	if password == "" {
		return nil, errors.New("falta la clave. Genera una con -new-key y arranca con -verifier, CRYPTOPO_VERIFIER o -password-file")
	}
	if len([]rune(strings.TrimSpace(password))) < minSecretLen {
		return nil, fmt.Errorf("la clave necesita al menos %d caracteres; -new-key genera una segura", minSecretLen)
	}
	return deriveVerifier(password)
}

// readSecret devuelve la clave en claro si se dio por -password, -password-file o CRYPTOPO_PASSWORD.
func readSecret(password, passwordFile string) (string, error) {
	if passwordFile != "" {
		b, err := os.ReadFile(passwordFile)
		return strings.TrimSpace(string(b)), err
	}
	if password == "" {
		password = getenv("PASSWORD")
	}
	return strings.TrimSpace(password), nil
}

func printNewKey() error {
	secret := newSecret()
	v, err := deriveVerifier(secret)
	if err != nil {
		return err
	}
	fmt.Printf("Clave de sala, solo para los participantes:\n  %s\n", secret)
	fmt.Printf("Verificador, para el servidor (no descifra nada):\n  %s\n", hex.EncodeToString(v))
	fmt.Printf("Invitación: https://TU-HOST/#k=%s\n", secret)
	return nil
}

// getenv lee CRYPTOPO_<name> y, si no está, el nombre de antes del cambio de nombre (NEWCHORD_<name>).
func getenv(name string) string {
	if v := os.Getenv("CRYPTOPO_" + name); v != "" {
		return v
	}
	return os.Getenv("NEWCHORD_" + name)
}

func envOr(value, name string) string {
	if value != "" {
		return value
	}
	return getenv(name)
}

// legacyPath devuelve old si path aún no existe y old sí: los datos de antes del cambio de nombre
// (newchord) se siguen usando donde están, sin moverlos ni copiarlos.
func legacyPath(path, old string) string {
	if _, err := os.Stat(path); err == nil {
		return path
	}
	if _, err := os.Stat(old); err == nil {
		log.Printf("usando %s, el nombre anterior de %s", old, path)
		return old
	}
	return path
}

func main() {
	// Sin argumentos, el doble clic: abre el panel si este binario lo incluye.
	if panelAvailable && len(os.Args) == 1 {
		runPanel()
		return
	}
	addr := flag.String("addr", "127.0.0.1:8080", "dirección de escucha")
	channels := flag.String("channels", defaultChannels, "canales fijos, separados por coma")
	stun := flag.String("stun", defaultSTUN, "servidores STUN")
	turn := flag.String("turn", "", "servidores TURN (ej. turn:mi.host:3478,turns:mi.host:5349)")
	turnUser := flag.String("turn-user", "", "usuario TURN fijo")
	turnPass := flag.String("turn-pass", "", "contraseña TURN fija (mejor CRYPTOPO_TURN_PASS o -turn-secret)")
	turnSecret := flag.String("turn-secret", "", "secreto use-auth-secret de coturn: credenciales que caducan (o CRYPTOPO_TURN_SECRET)")
	relayOnly := flag.Bool("relay-only", false, "todo por TURN: los participantes no ven la IP de los demás")
	builtinTurn := flag.Bool("builtin-turn", false, "TURN integrado, solo para navegadores en esta máquina (pruebas); el panel lo publica por Funnel")
	origins := flag.String("origins", "", "orígenes extra permitidos para el WebSocket")
	cert := flag.String("cert", "", "certificado TLS (opcional)")
	key := flag.String("key", "", "clave TLS (opcional)")
	staticDir := flag.String("static", "", "servir el frontend desde este directorio en vez del embebido")
	dbPath := flag.String("db", defaultDB, "base SQLite de sesiones y logs (vacío: no registrar nada)")
	retention := flag.Duration("retention", defaultRetention, "tiempo que se conservan sesiones y logs (0: siempre)")
	password := flag.String("password", "", "clave de sala (mejor -password-file o CRYPTOPO_PASSWORD: aquí queda en el historial)")
	passwordFile := flag.String("password-file", "", "fichero con la clave de sala")
	verifier := flag.String("verifier", "", "verificador de -new-key: el servidor no llega a conocer la clave de sala")
	newKey := flag.Bool("new-key", false, "genera una clave de sala y su verificador, y sale")
	insecureHTTP := flag.Bool("insecure-http", false, "permite HTTP en una dirección que no sea local; solo para pruebas en tu máquina")
	inviteBase := flag.String("invite", "", "imprime una invitación de un solo uso (24 h) para esta URL base, p. ej. https://host; exige la clave en claro (-password, -password-file o CRYPTOPO_PASSWORD)")
	maxRoom := flag.Int("max-room", defaultMaxRoom, "personas por sala")
	join := flag.String("join", "", "usar la interfaz de este binario contra un servidor remoto (https://...)")
	flag.Parse()

	if *newKey {
		if err := printNewKey(); err != nil {
			log.Fatal(err)
		}
		return
	}

	static, err := fs.Sub(dist, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	if *staticDir != "" {
		static = os.DirFS(*staticDir)
	}

	if *join != "" {
		target, err := parseJoinTarget(*join)
		if err != nil {
			log.Fatal(err)
		}
		listen := *addr
		addrSet := false
		flag.Visit(func(f *flag.Flag) { addrSet = addrSet || f.Name == "addr" })
		if !addrSet {
			listen = defaultJoinAddr
		}
		if !isLoopbackAddr(listen) {
			log.Fatal("-join solo escucha en una dirección local")
		}
		srv := newHTTPServer(newJoinHandler(target, static))
		srv.Addr = listen
		fmt.Printf("Abre http://%s y escribe la clave de sala. Señalización: %s\n", listen, target)
		log.Fatal(srv.ListenAndServe())
	}

	v, err := serverVerifier(*password, *passwordFile, *verifier)
	if err != nil {
		log.Fatal(err)
	}
	if *cert == "" && !isLoopbackAddr(*addr) && !*insecureHTTP {
		log.Fatalf("%s sin TLS expone el tráfico a la red. Usa -cert y -key, o escucha en 127.0.0.1 tras un túnel HTTPS", *addr)
	}

	var st *store
	if *dbPath == defaultDB {
		*dbPath = legacyPath(defaultDB, "newchord.db")
	}
	if *dbPath != "" {
		var err error
		if st, err = openStoreRetention(*dbPath, *retention); err != nil {
			log.Fatalf("abriendo %s: %v", *dbPath, err)
		}
		log.SetOutput(io.MultiWriter(os.Stderr, st))
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-sig
			st.Close()
			os.Exit(0)
		}()
	}

	h := &hub{
		clients: map[string]*client{}, channels: splitList(*channels), origins: splitList(*origins),
		store: st, verifier: v, authDelay: time.Second, maxRoom: *maxRoom,
	}
	err = h.configureICE(iceConfig{
		STUN: *stun, TURN: *turn, Secret: envOr(*turnSecret, "TURN_SECRET"),
		User: *turnUser, Pass: envOr(*turnPass, "TURN_PASS"), RelayOnly: *relayOnly, Builtin: *builtinTurn,
	})
	if err != nil {
		log.Fatal(err)
	}
	if *builtinTurn {
		t, err := startBuiltinTURN()
		if err != nil {
			log.Fatal(err)
		}
		h.setBuiltinTURN(t.secret, nil, t.localURLs())
	}

	if *inviteBase != "" {
		secret, err := readSecret(*password, *passwordFile)
		if err != nil || secret == "" {
			log.Fatal("-invite necesita la clave en claro: -password, -password-file o CRYPTOPO_PASSWORD, no -verifier")
		}
		link, err := h.issueInvite(*inviteBase, secret)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Invitación de un solo uso, válida %d min mientras este servidor siga en marcha:\n  %s\n", int(inviteTTL.Minutes()), link)
	}

	srv := newHTTPServer(newMux(h, static))
	srv.Addr = *addr
	log.Printf("cryptopo escuchando en %s", *addr)
	if *cert != "" {
		err = srv.ListenAndServeTLS(*cert, *key)
	} else {
		err = srv.ListenAndServe()
	}
	log.Print(err)
	st.Close()
	os.Exit(1)
}
