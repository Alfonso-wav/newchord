package main

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

// Misma derivación que web/src/e2e.ts. La clave de sala da un secreto maestro y de
// él salen, por HKDF, el verificador para este servidor y la clave de señalización
// para los navegadores. Con solo el verificador no se puede obtener la segunda.
const (
	kdfSalt       = "newchord-v1"
	kdfIterations = 600_000
	authContext   = "newchord-auth-v1|"
	minSecretLen  = 16
)

func deriveVerifier(secret string) ([]byte, error) {
	normal := norm.NFC.String(strings.TrimSpace(secret))
	master, err := pbkdf2.Key(sha256.New, normal, []byte(kdfSalt), kdfIterations, 32)
	if err != nil {
		return nil, err
	}
	return hkdf.Key(sha256.New, master, []byte(kdfSalt), "auth", 32)
}

func authProof(verifier []byte, nonce string) []byte {
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(authContext + nonce))
	return mac.Sum(nil)
}

func validProof(verifier []byte, nonce, proof string) bool {
	got, err := hex.DecodeString(proof)
	return err == nil && hmac.Equal(got, authProof(verifier, nonce))
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newSecret() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// turnCredentials sigue el esquema "use-auth-secret" de coturn: caducan solas y no
// hay una contraseña común que todos los clientes conozcan.
func turnCredentials(secret, clientID string, ttl time.Duration, at time.Time) (user, credential string) {
	user = fmt.Sprintf("%d:%s", at.Add(ttl).Unix(), clientID)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(user))
	return user, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// inviteFragment codifica la clave para el #k= del enlace. Todo lo que no sea [A-Za-z0-9_.-] va
// como %XX: decodeURIComponent no traduce el «+» de QueryEscape a espacio, y Wails rechaza abrir
// URLs con «~», «!», «(» y otros caracteres que una clave escrita a mano puede tener.
func inviteFragment(secret string) string {
	var b strings.Builder
	for _, c := range []byte(secret) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
