//go:build !desktop && !bindings && !dev

package main

// Sin los tags de Wails (go build, go test, E2E) no hay panel ni hace falta compilarlo.
const panelAvailable = false

func runPanel() {}
