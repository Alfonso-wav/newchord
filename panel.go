//go:build desktop || bindings || dev

package main

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
	"tailscale.com/client/local"
	"tailscale.com/envknob"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

// El directorio se llama frontend a propósito: con otro nombre, wails build sustituye
// cualquier embed llamado dist por este frontend, y web/dist dejaría de ser la llamada.
//
//go:embed all:frontend/dist
var panelAssets embed.FS

const panelAvailable = true

const dpapiUIForbidden = 1

// diskSettings es lo que llega al disco: la clave va cifrada con DPAPI, ligada a esta
// cuenta de Windows, para que no salga en copias de seguridad ni en un disco robado.
type diskSettings struct {
	Port      int    `json:"port"`
	Channels  string `json:"channels"`
	Protected string `json:"protectedKey,omitempty"`
	Legacy    string `json:"password,omitempty"` // versiones anteriores, en claro; se reescribe al abrir

	TurnMode    string `json:"turnMode,omitempty"`    // off, builtin, own
	TurnBuiltin bool   `json:"turnBuiltin,omitempty"` // versión anterior de turnMode; solo se lee
}

// seal y unseal guardan un secreto con DPAPI en base64; vacío se queda vacío.
func seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	b, err := dpapi([]byte(plain), true)
	return base64.StdEncoding.EncodeToString(b), err
}

func unseal(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return "", err
	}
	plain, err := dpapi(raw, false)
	return string(plain), err
}

func dpapi(in []byte, protect bool) ([]byte, error) {
	if len(in) == 0 {
		return nil, errors.New("sin datos")
	}
	input := windows.DataBlob{Size: uint32(len(in)), Data: &in[0]}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&input, nil, nil, 0, nil, dpapiUIForbidden, &out)
	} else {
		err = windows.CryptUnprotectData(&input, nil, nil, 0, nil, dpapiUIForbidden, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

type Settings struct {
	Port     int    `json:"port"`
	Channels string `json:"channels"`
	Password string `json:"password"`

	// Se cambia solo con los botones de TURN (SetTURN); los datos del propio van en turn.json.
	TurnMode string `json:"turnMode"`
}

// State es lo que pinta el panel en cada refresco.
type State struct {
	Server      bool   `json:"server"`
	Funnel      string `json:"funnel"` // off, starting, login, approve, on, error
	URL         string `json:"url"`
	ApproveURL  string `json:"approveUrl"`
	Message     string `json:"message"`
	HasPassword bool   `json:"hasPassword"`
	Turn        string `json:"turn"` // off, local (sin Funnel: aún no llega a invitados), on, ext (TURN de Settings)
}

type App struct {
	ctx  context.Context
	dir  string
	st   *store
	mu   sync.Mutex
	cfg  Settings
	hub  *hub
	srv  *http.Server
	stop context.CancelFunc

	ts       *tsnet.Server
	tsCancel context.CancelFunc
	tsLC     *local.Client
	tsDomain string // con Funnel abierto

	turn       *builtinTURN
	turn8443   bool // la tailnet deja abrir 8443 por Funnel
	funnelMode string
	funnelURL  string
	approveURL string
	message    string
}

func runPanel() {
	app := &App{funnelMode: "off", cfg: Settings{Port: 8090, Channels: defaultChannels}}
	assets, err := fs.Sub(panelAssets, "frontend/dist")
	if err == nil {
		err = wails.Run(&options.App{
			Title: "cryptopo", Width: 1040, Height: 720, MinWidth: 760, MinHeight: 520,
			BackgroundColour: options.NewRGB(7, 9, 7),
			AssetServer:      &assetserver.Options{Assets: assets},
			OnStartup:        app.startup,
			OnShutdown:       app.shutdown,
			Bind:             []any{app},
		})
	}
	if err != nil {
		log.Fatal(err)
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	base, err := os.UserConfigDir()
	if err == nil {
		// Ajustes, clave protegida, registro y estado de Tailscale de cuando se llamaba newchord:
		// si existen, se siguen usando en su sitio.
		a.dir = legacyPath(filepath.Join(base, "cryptopo"), filepath.Join(base, "newchord"))
		err = os.MkdirAll(a.dir, 0o700)
	}
	if err == nil {
		err = a.loadSettings()
	}
	if err == nil {
		a.st, err = openStore(legacyPath(filepath.Join(a.dir, "cryptopo.db"), filepath.Join(a.dir, "newchord.db")))
	}
	if err != nil {
		a.message = "Error al abrir los datos: " + err.Error()
		return
	}
	log.SetOutput(a.st)
}

func (a *App) shutdown(context.Context) {
	a.StopServer() // también cierra el Funnel
	a.st.Close()
}

func (a *App) settingsPath() string { return filepath.Join(a.dir, "settings.json") }

// loadSettings genera una clave aleatoria la primera vez y sustituye la que fuera
// demasiado corta: el host nunca arranca con una clave que se pueda adivinar.
func (a *App) loadSettings() error {
	b, err := os.ReadFile(a.settingsPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var d diskSettings
	if err == nil {
		if err := json.Unmarshal(b, &d); err != nil {
			return err
		}
		if d.Port != 0 {
			a.cfg.Port = d.Port
		}
		a.cfg.Channels = d.Channels
		a.cfg.TurnMode = d.TurnMode
		if a.cfg.TurnMode == "" && d.TurnBuiltin {
			a.cfg.TurnMode = turnBuiltinMode
		}
	}
	a.cfg.Password = d.Legacy
	if d.Protected != "" {
		raw, err := base64.StdEncoding.DecodeString(d.Protected)
		if err != nil {
			return err
		}
		// Otro usuario u otra máquina no pueden descifrarla: se genera una nueva.
		if plain, err := dpapi(raw, false); err == nil {
			a.cfg.Password = string(plain)
		}
	}
	regenerated := len([]rune(strings.TrimSpace(a.cfg.Password))) < minSecretLen
	if regenerated {
		a.cfg.Password = newSecret()
	}
	if regenerated || d.Legacy != "" {
		return a.writeSettings(a.cfg)
	}
	return nil
}

func (a *App) writeSettings(s Settings) error {
	d := diskSettings{Port: s.Port, Channels: s.Channels, TurnMode: s.TurnMode}
	var err error
	if d.Protected, err = seal(s.Password); err != nil {
		return err
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath(), b, 0o600)
}

// NewKey propone una clave aleatoria; no se aplica hasta guardar.
func (a *App) NewKey() string { return newSecret() }

func (a *App) ClearLogs() { a.st.Clear() }

func (a *App) State() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	return State{
		Server: a.srv != nil, Funnel: a.funnelMode, URL: a.funnelURL, ApproveURL: a.approveURL,
		Message: a.message, HasPassword: a.cfg.Password != "", Turn: a.turnStateLocked(),
	}
}

func (a *App) Settings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// SaveSettings aplica la contraseña en caliente. Puerto y canales exigen parar el server.
func (a *App) SaveSettings(s Settings) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len([]rune(strings.TrimSpace(s.Password))) < minSecretLen {
		return fmt.Errorf("la clave necesita al menos %d caracteres", minSecretLen)
	}
	if s.Port < 1024 || s.Port > 65535 {
		return errors.New("el puerto debe estar entre 1024 y 65535")
	}
	s.TurnMode = a.cfg.TurnMode // tiene sus propios botones
	if a.srv != nil && (s.Port != a.cfg.Port || s.Channels != a.cfg.Channels) {
		return errors.New("para el server antes de cambiar puerto o canales")
	}
	verifier, err := deriveVerifier(s.Password)
	if err != nil {
		return err
	}
	if err := a.writeSettings(s); err != nil {
		return err
	}
	a.cfg = s
	if a.hub != nil {
		a.hub.setVerifier(verifier)
	}
	return nil
}

func (a *App) StartServer() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.srv != nil {
		return nil
	}
	if a.st == nil {
		return errors.New(a.message)
	}
	verifier, err := deriveVerifier(a.cfg.Password)
	if err != nil {
		return err
	}
	static, err := fs.Sub(dist, "web/dist")
	if err != nil {
		return err
	}
	h := &hub{
		clients: map[string]*client{}, channels: splitList(a.cfg.Channels),
		store: a.st, verifier: verifier, authDelay: time.Second,
	}
	// Un TURN que falla no impide arrancar: la llamada sigue sin él y el panel lo avisa.
	turnErr := a.applyTURNLocked(h)
	addr := "127.0.0.1:" + strconv.Itoa(a.cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		a.stopTURNLocked()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv := newHTTPServer(newMux(h, static))
	srv.BaseContext = func(net.Listener) context.Context { return ctx }
	go srv.Serve(ln)
	a.hub, a.srv, a.stop = h, srv, cancel
	a.message = ""
	if turnErr != nil {
		a.message = "Server arrancado sin TURN: " + turnErr.Error()
	}
	log.Printf("server en %s, TURN %s", addr, a.turnStateLocked())
	return nil
}

func (a *App) StopServer() {
	a.StopFunnel()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.srv == nil {
		return
	}
	a.hub.mu.Lock()
	a.hub.closeAllLocked("server-stop")
	a.hub.mu.Unlock()
	a.stop() // corta también las conexiones aún sin autenticar
	a.srv.Close()
	a.stopTURNLocked()
	a.hub, a.srv, a.stop = nil, nil, nil
	log.Print("server parado")
}

var reSafeURL = regexp.MustCompile(`^https://login\.tailscale\.com/[^\s]+$`)

// El nodo de Tailscale va dentro del binario (tsnet): quien recibe el exe no instala
// nada. Funnel se configura igual que haría "tailscale funnel <puerto>": Tailscale
// termina TLS y hace de proxy hacia 127.0.0.1, así X-Forwarded-For llega desde loopback.
func (a *App) StartFunnel() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ts != nil {
		return nil
	}
	if a.srv == nil || a.cfg.Password == "" {
		return errors.New("arranca antes el server")
	}
	envknob.SetNoLogsNoSupport() // no subir logs del nodo a Tailscale
	quiet := func(string, ...any) {}
	ts := &tsnet.Server{
		Dir: filepath.Join(a.dir, "tailscale"), Hostname: "cryptopo",
		Logf: quiet, UserLogf: quiet,
	}
	lc, err := ts.LocalClient() // arranca el nodo; no espera a la red
	if err != nil {
		ts.Close()
		return fmt.Errorf("Tailscale: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.ts, a.tsCancel = ts, cancel
	a.funnelMode, a.funnelURL, a.approveURL, a.message = "starting", "", "", ""
	log.Print("funnel: abriendo")
	go a.runFunnel(ctx, ts, lc)
	return nil
}

// funnelSet cambia el estado solo si este nodo sigue siendo el actual.
func (a *App) funnelSet(ts *tsnet.Server, mode, approve, msg string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ts == ts {
		a.funnelMode, a.approveURL, a.message = mode, approve, msg
	}
}

func (a *App) runFunnel(ctx context.Context, ts *tsnet.Server, lc *local.Client) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	wait := func() bool {
		select {
		case <-ctx.Done():
			return false
		case <-tick.C:
			return true
		}
	}
	// 1. Sesión: la primera vez Tailscale da un enlace para entrar con tu cuenta.
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil && st.BackendState == "Running" {
			break
		}
		switch {
		case err != nil:
		case st.AuthURL != "":
			a.funnelSet(ts, "login", st.AuthURL, "")
		case st.BackendState == "NeedsMachineAuth":
			a.funnelSet(ts, "starting", "", "El administrador de tu tailnet tiene que aprobar este equipo.")
		}
		if !wait() {
			return
		}
	}
	a.funnelSet(ts, "starting", "", "")
	st, err := ts.Up(ctx) // la primera vez borra la config serve anterior: antes de poner la nuestra
	if err != nil {
		if ctx.Err() == nil {
			a.funnelSet(ts, "error", "", "Tailscale: "+err.Error())
		}
		return
	}
	// 2. HTTPS y Funnel se activan una vez por tailnet desde la web de Tailscale.
	for ipn.NodeCanFunnel(st.Self) != nil {
		if q, err := lc.QueryFeature(ctx, "funnel"); err == nil && q.URL != "" {
			a.funnelSet(ts, "approve", q.URL, "")
		}
		if !wait() {
			return
		}
		if st, err = lc.StatusWithoutPeers(ctx); err != nil {
			continue
		}
	}
	if err := ipn.CheckFunnelPort(443, st.Self); err != nil {
		a.funnelSet(ts, "error", "", "Tailscale: "+err.Error())
		return
	}
	if len(st.CertDomains) == 0 {
		a.funnelSet(ts, "error", "", "Tailscale no da nombre HTTPS a este equipo")
		return
	}
	domain := st.CertDomains[0]
	a.mu.Lock()
	if a.ts == ts {
		a.tsLC, a.tsDomain = lc, domain
		a.turn8443 = ipn.CheckFunnelPort(8443, st.Self) == nil
	}
	a.mu.Unlock()
	if err := a.applyServe(ctx); err != nil {
		if ctx.Err() == nil {
			a.funnelSet(ts, "error", "", "Tailscale: "+err.Error())
		}
		return
	}
	// El certificado se pide la primera vez que alguien entra: así no le toca esperar al invitado.
	go lc.CertPair(ctx, domain)
	a.mu.Lock()
	if a.ts == ts {
		a.funnelMode, a.funnelURL, a.approveURL, a.message = "on", "https://"+domain, "", ""
	}
	a.mu.Unlock()
	log.Printf("funnel: abierto en https://%s", domain)

	// 3. Si se cae la conexión con Tailscale, se refleja en el panel hasta que vuelva.
	for wait() {
		st, err := lc.StatusWithoutPeers(ctx)
		mode := "on"
		if err != nil || st.BackendState != "Running" {
			mode = "starting"
		}
		a.mu.Lock()
		if a.ts == ts && a.funnelMode != mode {
			a.funnelMode = mode
		}
		a.mu.Unlock()
	}
}

// StopFunnel apaga el nodo: sin el panel abierto, la URL deja de responder.
func (a *App) StopFunnel() {
	a.mu.Lock()
	ts, cancel := a.ts, a.tsCancel
	a.ts, a.tsCancel, a.tsLC, a.tsDomain = nil, nil, nil, ""
	a.funnelMode, a.funnelURL, a.approveURL = "off", "", ""
	if a.hub != nil {
		a.pushTURNLocked(a.hub) // sin Funnel, los invitados dejan de recibir la URL del TURN
	}
	a.mu.Unlock()
	if ts == nil {
		return
	}
	cancel()
	if lc, err := ts.LocalClient(); err == nil {
		ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
		lc.SetServeConfig(ctx, &ipn.ServeConfig{})
		done()
	}
	ts.Close()
	log.Print("funnel: cerrado")
}

// applyServe publica la web en 443 y, con el TURN integrado, el TURN en 8443. Tailscale
// termina TLS en los dos: al TURN le llega TCP en claro por 127.0.0.1.
func (a *App) applyServe(ctx context.Context) error {
	a.mu.Lock()
	lc, domain, port, h := a.tsLC, a.tsDomain, a.cfg.Port, a.hub
	turnPort := 0
	if a.turn != nil && a.turn8443 {
		turnPort = a.turn.port()
	}
	a.mu.Unlock()
	if lc == nil {
		return nil
	}
	web := ipn.HostPort(domain + ":443")
	cfg := &ipn.ServeConfig{
		TCP: map[uint16]*ipn.TCPPortHandler{443: {HTTPS: true}},
		Web: map[ipn.HostPort]*ipn.WebServerConfig{web: {Handlers: map[string]*ipn.HTTPHandler{
			"/": {Proxy: "http://127.0.0.1:" + strconv.Itoa(port)},
		}}},
		AllowFunnel: map[ipn.HostPort]bool{web: true},
	}
	if turnPort != 0 {
		cfg.TCP[8443] = &ipn.TCPPortHandler{TCPForward: "127.0.0.1:" + strconv.Itoa(turnPort), TerminateTLS: domain}
		cfg.AllowFunnel[ipn.HostPort(domain+":8443")] = true
	}
	if err := lc.SetServeConfig(ctx, cfg); err != nil {
		return err
	}
	// Solo tras publicar 8443 se reparte la URL: antes, el invitado probaría un puerto cerrado.
	a.mu.Lock()
	if h != nil && a.hub == h {
		a.pushTURNLocked(h)
	}
	a.mu.Unlock()
	return nil
}

func (a *App) Sessions() ([]sessionRow, error) {
	if a.st == nil {
		return []sessionRow{}, nil
	}
	return a.st.sessions(100)
}

func (a *App) Events() ([]eventRow, error) {
	if a.st == nil {
		return []eventRow{}, nil
	}
	return a.st.events(200)
}

// newInviteLink crea una invitación de un solo uso (24 h). El enlace no lleva la clave de sala:
// lleva un id que el servidor canjea una vez y la clave con la que se abre el sobre, tras el #.
func (a *App) newInviteLink() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.funnelURL == "" || a.hub == nil {
		return "", errors.New("abre antes el Funnel")
	}
	return a.hub.issueInvite(a.funnelURL, a.cfg.Password)
}

func (a *App) CopyInvite() error {
	link, err := a.newInviteLink()
	if err != nil {
		return err
	}
	text := fmt.Sprintf("%s\nÁbrelo en Chrome. Vale una sola vez y caduca en %d horas.", link, int(inviteTTL.Hours()))
	return runtime.ClipboardSetText(a.ctx, text)
}

// ShareWhatsApp abre WhatsApp (app o web) con una invitación nueva ya escrita; solo queda elegir el chat.
func (a *App) ShareWhatsApp() error {
	link, err := a.newInviteLink()
	if err != nil {
		return err
	}
	runtime.BrowserOpenURL(a.ctx, whatsAppURL(link, inviteTTL))
	return nil
}

func (a *App) OpenCall() {
	a.mu.Lock()
	port, secret := a.cfg.Port, a.cfg.Password
	a.mu.Unlock()
	runtime.BrowserOpenURL(a.ctx, fmt.Sprintf("http://127.0.0.1:%d/#k=%s", port, inviteFragment(secret)))
}

func (a *App) OpenURL(u string) {
	if reSafeURL.MatchString(u) {
		runtime.BrowserOpenURL(a.ctx, u)
	}
}
