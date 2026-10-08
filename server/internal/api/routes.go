package api

import (
	"cmp"
	"context"
	"glimway/content"
	"net/http"
	"slices"
	"strings"
	"time"
)

func (a *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Log fixed route labels only. No bodies, headers, raw paths or query strings.
	route := "unknown"
	if slices.Contains([]string{"/api/health", "/ws", "/api/session", "/api/origin", "/api/play", "/api/state", "/api/progress", "/api/sync", "/api/spend", "/api/invites", "/api/commons", "/api/calendar", "/api/storage", "/api/craft", "/api/hearth/craft", "/api/desk/copy", "/api/homestead/woodpile", "/api/mail", "/api/projects", "/api/library", "/api/library/donate", "/api/items", "/api/world", "/api/world/party", "/api/world/prompt", "/api/world/move", "/api/world/leave", "/api/world/notice", "/api/world/choice", "/api/world/choose"}, r.URL.Path) {
		route = r.URL.Path
	}
	observed := &statusWriter{ResponseWriter: w, status: 200}
	w = observed
	if strings.HasPrefix(r.URL.Path, "/api/invites/") {
		route = "/api/invites/:id"
	}
	if strings.HasPrefix(r.URL.Path, "/api/homestead/") {
		route = "/api/homestead/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/mail/") {
		route = "/api/mail/:id/claim"
	}
	if strings.HasPrefix(r.URL.Path, "/api/projects/") {
		route = "/api/projects/:id/contribute"
	}
	if strings.HasPrefix(r.URL.Path, "/api/wilds/") {
		route = "/api/wilds/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/items/") {
		route = "/api/items/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/repairs/") {
		route = "/api/repairs/:id/mend"
	}
	if strings.HasPrefix(r.URL.Path, "/api/sprites/") {
		route = "/api/sprites/:name"
	}
	defer func() {
		class := "none"
		if observed.status == 502 {
			class = "upstream"
		} else if observed.status >= 500 {
			class = "internal"
		}
		a.Config.Logger.Printf("request method=%s route=%s status=%d error_class=%s", safeMethod(r.Method), route, observed.status, class)
	}()
	if r.Method != "GET" && r.Method != "HEAD" {
		if !sameOrigin(r, false) {
			problem(w, fail(403, "cross-origin"))
			return
		}
		if r.Method != "DELETE" && !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			problem(w, fail(415, "json-required"))
			return
		}
	}
	var err error
	switch r.Method + " " + r.URL.Path {
	case "GET /api/health", "HEAD /api/health":
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if a.Store.DB.PingContext(ctx) != nil {
			err = fail(503, "internal")
		} else if r.Method == "HEAD" {
			w.WriteHeader(http.StatusOK)
		} else {
			health := map[string]string{"status": "ok", "version": cmp.Or(a.Config.Version, "dev")}
			if a.Config.Build != "" {
				health["build"] = a.Config.Build
			}
			write(w, 200, health)
		}
	case "GET /ws":
		err = a.presenceSocket(w, r)
	case "POST /api/invites":
		err = a.createInvite(w, r)
	case "GET /api/invites":
		err = a.listInvites(w, r)
	case "GET /api/world":
		err = a.worldRead(w, r)
	case "POST /api/world/party":
		err = a.worldParty(w, r)
	case "POST /api/world/prompt":
		err = a.worldPrompt(w, r)
	case "POST /api/world/move":
		err = a.worldMove(w, r)
	case "POST /api/world/leave":
		err = a.worldLeave(w, r)
	case "POST /api/world/notice":
		err = a.worldNotice(w, r)
	case "GET /api/world/choice":
		err = a.worldChoiceRead(w, r)
	case "POST /api/world/choose":
		err = a.worldChoose(w, r)
	case "POST /api/session":
		err = a.login(w, r)
	case "DELETE /api/session":
		err = a.logout(w, r)
	case "GET /api/state":
		err = a.state(w, r)
	case "POST /api/play":
		err = a.play(w, r)
	case "POST /api/origin":
		err = a.origin(w, r)
	case "PUT /api/progress":
		err = a.progress(w, r)
	case "POST /api/sync":
		err = a.sync(w, r)
	case "GET /api/commons":
		err = a.commons(w, r)
	case "GET /api/calendar":
		writeProto(w, 200, calendarResponse(content.CalendarAt(content.CalendarRules, a.Config.Now().Unix())))
	case "GET /api/storage":
		err = a.storageRead(w, r)
	case "POST /api/storage":
		err = a.storageMutation(w, r)
	case "POST /api/craft":
		err = a.craft(w, r)
	case "POST /api/hearth/craft":
		err = a.hearthCraft(w, r)
	case "POST /api/desk/copy":
		err = a.deskCopy(w, r)
	case "GET /api/homestead/woodpile":
		err = a.woodpileRead(w, r)
	case "POST /api/homestead/woodpile":
		err = a.woodpileMutation(w, r)
	case "GET /api/homestead/shelf":
		err = a.shelfRead(w, r)
	case "POST /api/homestead/shelf":
		err = a.shelfMutation(w, r)
	case "GET /api/mail":
		err = a.mailRead(w, r)
	case "POST /api/mail":
		err = a.mailSend(w, r)
	case "GET /api/projects":
		err = a.projectsRead(w, r)
	case "GET /api/library":
		err = a.libraryRead(w, r)
	case "POST /api/library/donate":
		err = a.libraryDonate(w, r)
	case "POST /api/wilds/claim", "POST /api/wilds/lantern", "POST /api/wilds/defeat":
		err = a.wildsMutation(w, r)
	case "POST /api/homestead/buy", "POST /api/homestead/place", "POST /api/homestead/remove", "POST /api/homestead/move", "POST /api/homestead/upgrade",
		"POST /api/homestead/claim", "POST /api/homestead/clear", "POST /api/homestead/invite", "POST /api/homestead/joint", "POST /api/homestead/leave":
		err = a.homeMutation(w, r)
	case "POST /api/spend":
		err = a.spend(w, r)
	case "GET /api/items":
		err = a.itemsRead(w, r)
	case "POST /api/items/use", "POST /api/items/repair", "POST /api/items/fit", "POST /api/items/unfit", "POST /api/items/give",
		"POST /api/items/pocket", "POST /api/items/offhand", "POST /api/items/pickup", "POST /api/items/return",
		"POST /api/items/heirloom", "POST /api/items/ada-oil", "POST /api/items/gather", "POST /api/items/plant",
		"POST /api/items/buy":
		err = a.itemsMutation(w, r)
	case "GET /api/repairs":
		err = a.repairsRead(w, r)
	default:
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/mail/") {
			if strings.HasSuffix(r.URL.Path, "/recall") {
				err = a.mailRecall(w, r)
			} else {
				err = a.mailClaim(w, r)
			}
		} else if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/projects/") {
			err = a.projectContribute(w, r)
		} else if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/repairs/") && strings.HasSuffix(r.URL.Path, "/mend") {
			err = a.repairMend(w, r)
		} else if r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/invites/") {
			err = a.revokeInvite(w, r)
		} else if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/homestead/") {
			err = a.homeRead(w, r)
		} else if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/wilds/region/") {
			err = a.regionRead(w, r)
		} else if (r.Method == "GET" || r.Method == "HEAD") && strings.HasPrefix(r.URL.Path, "/api/sprites/") {
			err = a.sprite(w, r)
		} else {
			err = fail(404, "not-found")
		}
	}
	if err != nil {
		problem(w, err)
	}
}

func safeMethod(m string) string {
	if slices.Contains([]string{"GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"}, m) {
		return m
	}
	return "other"
}
