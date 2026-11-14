package main

import (
	"io/fs"
	"path"
	"strings"
	"testing"
)

// embeddedLeaks busca en lo que va dentro del exe cualquier cosa que no sea la web:
// logs, bases, ajustes o estado de Tailscale no deben viajar al repartir el binario.
func embeddedLeaks(fsys fs.FS) []string {
	allowed := map[string]bool{
		".html": true, ".js": true, ".css": true, ".ico": true, ".png": true, ".svg": true,
		".woff": true, ".woff2": true, ".webmanifest": true, ".txt": true, ".map": false,
	}
	var bad []string
	fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := strings.ToLower(path.Base(p))
		// WebAssembly de SQLite y ONNX junto a sus scripts, y el modelo del dictado con su
		// configuración solo en su carpeta: un .json suelto podría ser un settings.json.
		wasm := path.Ext(name) == ".wasm" && strings.HasPrefix(p, "web/dist/assets/")
		model := (path.Ext(name) == ".json" || path.Ext(name) == ".onnx") && strings.HasPrefix(p, "web/dist/stt/models/")
		if !allowed[path.Ext(name)] && !wasm && !model && name != ".keep" && name != ".gitkeep" {
			bad = append(bad, p)
		}
		return nil
	})
	return bad
}

func TestEmbeddedWebHasNoLogsOrState(t *testing.T) {
	if bad := embeddedLeaks(dist); len(bad) > 0 {
		t.Fatalf("el exe llevaría ficheros que no son la web: %v", bad)
	}
}
