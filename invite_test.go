package main

import (
	"net/url"
	"regexp"
	"testing"
)

// Copia de las comprobaciones de Wails 2.17 (internal/frontend/utils/urlValidator.go) que hace
// BrowserOpenURL antes de abrir «Entrar a la llamada»: si falla, el botón no hace nada.
var wailsShellDangerous = regexp.MustCompile(`[;\|` + "`" + `$\<>*{}\[\]()~! \t\n\r]`)

func TestInviteFragmentSurvivesWailsAndDecodes(t *testing.T) {
	for _, secret := range []string{
		newSecret(),
		"clave con espacios y + signos",
		"~tilde!(paréntesis)*$;|<>{}[]`\\",
		"ñandú-ümlaut-日本語-🙂-larga",
		"100%-real-%41-no-es-A",
	} {
		raw := "http://127.0.0.1:8090/#k=" + inviteFragment(secret)
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("%q: %v", secret, err)
		}
		opened := u.String()
		if wailsShellDangerous.MatchString(opened) {
			t.Fatalf("%q: Wails no abriría %s", secret, opened)
		}
		// decodeURIComponent en el navegador: como PathUnescape, «+» se queda como «+».
		frag, _ := url.Parse(opened)
		got, err := url.PathUnescape(frag.EscapedFragment()[len("k="):])
		if err != nil || got != secret {
			t.Fatalf("%q: llega %q (%v) desde %s", secret, got, err, opened)
		}
	}
}
