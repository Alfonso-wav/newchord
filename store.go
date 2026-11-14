package main

import (
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
	id            TEXT PRIMARY KEY,
	client_id     TEXT NOT NULL,
	name          TEXT NOT NULL,
	room          TEXT NOT NULL,
	ip            TEXT,
	forwarded_for TEXT,
	user_agent    TEXT,
	joined_at     TEXT NOT NULL,
	left_at       TEXT,
	left_reason   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_joined_at ON sessions(joined_at);
CREATE TABLE IF NOT EXISTS events (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	ts            TEXT NOT NULL,
	kind          TEXT NOT NULL,
	client_id     TEXT,
	name          TEXT,
	ip            TEXT,
	forwarded_for TEXT,
	user_agent    TEXT,
	detail        TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`

// netInfo identifica el origen de una conexión. forwarded viene de una cabecera
// que el cliente puede falsear si llega sin proxy: se guarda aparte de ip.
type netInfo struct {
	ip        string
	forwarded string
	ua        string
}

func netInfoFrom(r *http.Request) netInfo {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	n := netInfo{ip: ip, ua: clean(r.Header.Get("User-Agent"), 300)}
	// Solo un proxy en esta máquina puede dar la IP. Sin él, la cabecera la escribe el
	// propio cliente, que podría hacerse pasar por otro en los logs y en los límites.
	if addr := net.ParseIP(ip); addr != nil && addr.IsLoopback() {
		list := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		n.forwarded = clean(list[len(list)-1], 200) // el último lo añade el proxy; los anteriores, cualquiera
	}
	return n
}

func (n netInfo) clientIP() string {
	if n.forwarded != "" {
		return n.forwarded
	}
	return n.ip
}

type dbOp struct {
	query string
	args  []any
}

// store escribe en un único goroutine para no retener nunca h.mu con E/S de
// disco. Si la cola se llena, descarta: registrar no debe frenar la señalización.
// Todos los métodos admiten un *store nil, que es el registro desactivado.
type store struct {
	db      *sql.DB
	ops     chan dbOp
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	dropped atomic.Int64

	retention time.Duration
}

const (
	defaultRetention = 0       // 0: se conserva todo; -retention para caducar
	maxEventRows     = 100_000 // un aluvión de conexiones no llena el disco
)

func now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func openStore(path string) (*store, error) { return openStoreRetention(path, defaultRetention) }

func openStoreRetention(path string, retention time.Duration) (*store, error) {
	// Contiene quién habló con quién y cuándo: crearla antes para que nazca sin permisos para otros.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=secure_delete(on)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// Las sesiones abiertas son de un arranque que murió sin cerrarlas. No se
	// sabe cuándo acabaron, así que left_at queda vacío.
	if _, err := db.Exec(`UPDATE sessions SET left_reason = 'interrupted' WHERE left_at IS NULL AND left_reason IS NULL`); err != nil {
		db.Close()
		return nil, err
	}
	s := &store{db: db, ops: make(chan dbOp, 1024), stop: make(chan struct{}), done: make(chan struct{}), retention: retention}
	s.prune(time.Now())
	go s.run()
	return s, nil
}

func (s *store) run() {
	defer close(s.done)
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		select {
		case op := <-s.ops:
			s.apply(op)
		case t := <-tick.C:
			s.prune(t)
		case <-s.stop:
			for {
				select {
				case op := <-s.ops:
					s.apply(op)
				default:
					return
				}
			}
		}
	}
}

// apply informa por stderr y no con log: log también escribe en esta base, y un
// fallo de disco se realimentaría.
func (s *store) apply(op dbOp) {
	if _, err := s.db.Exec(op.query, op.args...); err != nil {
		fmt.Fprintf(os.Stderr, "sqlite: %v\n", err)
	}
}

// prune borra lo caducado de verdad: secure_delete sobrescribe las páginas, y el
// checkpoint vacía el WAL, donde si no seguirían las filas borradas.
func (s *store) prune(at time.Time) {
	if s.retention <= 0 {
		return
	}
	cutoff := at.Add(-s.retention).UTC().Format("2006-01-02T15:04:05.000Z")
	s.apply(dbOp{`DELETE FROM sessions WHERE joined_at < ? AND (left_at IS NOT NULL OR left_reason IS NOT NULL)`, []any{cutoff}})
	s.apply(dbOp{`DELETE FROM events WHERE ts < ?`, []any{cutoff}})
	s.apply(dbOp{`DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - ?`, []any{maxEventRows}})
	s.apply(dbOp{`PRAGMA wal_checkpoint(TRUNCATE)`, nil})
}

// Clear vacía el registro a petición del panel.
func (s *store) Clear() {
	if s == nil {
		return
	}
	s.enqueue(`DELETE FROM sessions WHERE left_at IS NOT NULL OR left_reason IS NOT NULL`)
	s.enqueue(`DELETE FROM events`)
	s.enqueue(`PRAGMA wal_checkpoint(TRUNCATE)`)
}

func (s *store) enqueue(query string, args ...any) {
	if s == nil {
		return
	}
	select {
	case s.ops <- dbOp{query, args}:
	default:
		s.dropped.Add(1)
	}
}

// Close vacía la cola, cierra las sesiones abiertas y la base.
func (s *store) Close() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		close(s.stop)
		<-s.done
		if _, err := s.db.Exec(`UPDATE sessions SET left_at = ?, left_reason = 'server-stop' WHERE left_at IS NULL AND left_reason IS NULL`, now()); err != nil {
			fmt.Fprintf(os.Stderr, "sqlite: %v\n", err)
		}
		if n := s.dropped.Load(); n > 0 {
			fmt.Fprintf(os.Stderr, "sqlite: %d registros descartados por cola llena\n", n)
		}
		s.db.Close()
	})
}

func (s *store) sessionStart(id, clientID, name, room string, n netInfo) {
	s.enqueue(`INSERT INTO sessions (id, client_id, name, room, ip, forwarded_for, user_agent, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, clientID, name, room, n.ip, n.forwarded, n.ua, now())
}

func (s *store) sessionEnd(id, reason string) {
	s.enqueue(`UPDATE sessions SET left_at = ?, left_reason = ? WHERE id = ?`, now(), reason, id)
}

func (s *store) event(kind, clientID, name string, n netInfo, detail string) {
	s.enqueue(`INSERT INTO events (ts, kind, client_id, name, ip, forwarded_for, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		now(), kind, clientID, name, n.ip, n.forwarded, n.ua, detail)
}

type sessionRow struct {
	Name     string `json:"name"`
	Room     string `json:"room"`
	IP       string `json:"ip"`
	JoinedAt string `json:"joinedAt"`
	LeftAt   string `json:"leftAt"`
	Reason   string `json:"reason"`
}

type eventRow struct {
	TS     string `json:"ts"`
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Detail string `json:"detail"`
}

// Tras un túnel, ip es el proxy local: forwarded_for es la que dice algo.
const ipExpr = `coalesce(nullif(forwarded_for, ''), ip, '')`

func (s *store) sessions(limit int) ([]sessionRow, error) {
	rows, err := s.db.Query(`SELECT name, room, `+ipExpr+`, joined_at, coalesce(left_at, ''), coalesce(left_reason, '')
		FROM sessions ORDER BY (left_at IS NULL AND left_reason IS NULL) DESC, joined_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []sessionRow{}
	for rows.Next() {
		var r sessionRow
		if err := rows.Scan(&r.Name, &r.Room, &r.IP, &r.JoinedAt, &r.LeftAt, &r.Reason); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *store) events(limit int) ([]eventRow, error) {
	rows, err := s.db.Query(`SELECT ts, kind, coalesce(name, ''), `+ipExpr+`, coalesce(detail, '') FROM events ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []eventRow{}
	for rows.Next() {
		var r eventRow
		if err := rows.Scan(&r.TS, &r.Kind, &r.Name, &r.IP, &r.Detail); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Write recibe la salida del paquete log.
func (s *store) Write(p []byte) (int, error) {
	s.event("log", "", "", netInfo{}, strings.TrimRight(string(p), "\r\n"))
	return len(p), nil
}
