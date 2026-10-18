package api

import "net/http"

// webSettingsPath answers the web client's settings: the settings file's
// [web] table as this caller's client reads it (server/internal/settings,
// WebFor), with "dev" set to the dev tools this account has, or null.
const webSettingsPath = "/api/web-settings"

// webSettings serves GET /api/web-settings. It needs no sign-in: a caller
// without a session gets the same settings and no dev tools.
func (a *Server) webSettings(w http.ResponseWriter, r *http.Request) error {
	var v any = map[string]any{"dev": nil}
	if a.Config.WebSettings != nil {
		v = a.Config.WebSettings(r)
	}
	write(w, 200, v)
	return nil
}
