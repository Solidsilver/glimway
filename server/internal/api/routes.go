package api

import (
	"cmp"
	"context"
	"glimway/content"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

func (a *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	began := time.Now()
	// Each transaction samples once, after beginTx holds the write lock.
	r, clock := a.withTxClock(r)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Log fixed route labels only. No bodies, headers, raw paths or query strings.
	metadata := routeFor(r.Method, r.URL.Path)
	route := "unknown"
	if metadata != nil {
		route = metadata.label
	}
	observed := &statusWriter{ResponseWriter: w, status: 200, route: route, beforeWrite: func() {
		w.Header().Set("X-Glimway-Now", strconv.FormatInt(clock().Unix(), 10))
		if route == "/api/wilds/near/:cx/:cy" || route == "/api/wilds/claim" {
			w.Header().Set("Server-Timing", "app;dur="+strconv.FormatFloat(float64(time.Since(began))/float64(time.Millisecond), 'f', 3, 64))
		}
	}, unexpected: func(err error) { a.logUnexpected(route, err) }}
	w = observed
	defer func() {
		class := "none"
		if observed.status == 502 {
			class = "upstream"
		} else if observed.status >= 500 {
			class = "internal"
		}
		a.Config.Logger.Printf("request method=%s route=%s status=%d error_class=%s", safeMethod(r.Method), route, observed.status, class)
	}()
	if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/health" && r.URL.Path != "/api/calendar" && !strings.HasPrefix(r.URL.Path, "/api/sprites/") {
		if r.Header.Get("X-Glimway-Contract") != strconv.Itoa(content.ContractNumber) {
			problem(w, fail(409, "reload-needed"))
			return
		}
	}
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
	if metadata != nil {
		err = metadata.handler(a, w, r)
	} else {
		err = fail(404, "not-found")
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

type routeMetadata struct {
	method, path, suffix, label string
	prefix                      bool
	handler                     func(*Server, http.ResponseWriter, *http.Request) error
}

var routes = []routeMetadata{
	{method: "GET", path: "/api/health", label: "/api/health", handler: (*Server).health},
	{method: "GET", path: webSettingsPath, label: webSettingsPath, handler: (*Server).webSettings},
	{method: "HEAD", path: "/api/health", label: "/api/health", handler: (*Server).health},
	{method: "POST", path: "/api/report", label: "/api/report", handler: (*Server).report},
	{method: "POST", path: "/api/quest/step", label: "/api/quest/step", handler: (*Server).questStep},
	{method: "POST", path: "/api/story/mark", label: "/api/story/mark", handler: (*Server).mark},
	{method: "POST", path: "/api/papers/take", label: "/api/papers/take", handler: (*Server).takePaper},
	{method: "POST", path: "/api/fall", label: "/api/fall", handler: (*Server).fall},
	{method: "POST", path: "/api/profile", label: "/api/profile", handler: (*Server).profileReport},
	{method: "GET", path: "/ws", label: "/ws", handler: (*Server).presenceSocket},
	{method: "POST", path: "/api/invites", label: "/api/invites", handler: (*Server).createInvite},
	{method: "GET", path: "/api/invites", label: "/api/invites", handler: (*Server).listInvites},
	{method: "GET", path: "/api/world", label: "/api/world", handler: (*Server).worldRead},
	{method: "POST", path: "/api/world/party", label: "/api/world/party", handler: (*Server).worldParty},
	{method: "POST", path: "/api/world/prompt", label: "/api/world/prompt", handler: (*Server).worldPrompt},
	{method: "POST", path: "/api/world/move", label: "/api/world/move", handler: (*Server).worldMove},
	{method: "POST", path: "/api/world/leave", label: "/api/world/leave", handler: (*Server).worldLeave},
	{method: "POST", path: "/api/world/notice", label: "/api/world/notice", handler: (*Server).worldNotice},
	{method: "GET", path: "/api/world/choice", label: "/api/world/choice", handler: (*Server).worldChoiceRead},
	{method: "POST", path: "/api/world/choose", label: "/api/world/choose", handler: (*Server).worldChoose},
	{method: "POST", path: "/api/session", label: "/api/session", handler: (*Server).login},
	{method: "POST", path: "/api/purse/top-up", label: "/api/purse/top-up", handler: (*Server).purseTopUp},
	{method: "GET", path: "/api/purse", label: "/api/purse", handler: (*Server).purseRead},
	{method: "POST", path: "/api/wardrobe/check", label: "/api/wardrobe/check", handler: (*Server).wardrobeCheck},
	{method: "DELETE", path: "/api/session", label: "/api/session", handler: (*Server).logout},
	{method: "GET", path: "/api/operations/result", label: "/api/operations/result", handler: (*Server).operationResult},
	{method: "GET", path: "/api/state", label: "/api/state", handler: (*Server).state},
	{method: "POST", path: "/api/play", label: "/api/play", handler: (*Server).play},
	{method: "GET", path: "/api/commons", label: "/api/commons", handler: (*Server).commons},
	{method: "GET", path: "/api/calendar", label: "/api/calendar", handler: (*Server).calendar},
	{method: "GET", path: "/api/storage", label: "/api/storage", handler: (*Server).storageRead},
	{method: "POST", path: "/api/storage", label: "/api/storage", handler: (*Server).storageMutation},
	{method: "POST", path: "/api/craft", label: "/api/craft", handler: (*Server).craft},
	{method: "POST", path: "/api/hearth/craft", label: "/api/hearth/craft", handler: (*Server).hearthCraft},
	{method: "POST", path: "/api/desk/copy", label: "/api/desk/copy", handler: (*Server).deskCopy},
	{method: "GET", path: "/api/homestead/woodpile", label: "/api/homestead/woodpile", handler: (*Server).woodpileRead},
	{method: "POST", path: "/api/homestead/woodpile", label: "/api/homestead/woodpile", handler: (*Server).woodpileMutation},
	{method: "GET", path: "/api/homestead/shelf", label: "/api/homestead/shelf", handler: (*Server).shelfRead},
	{method: "POST", path: "/api/homestead/shelf", label: "/api/homestead/shelf", handler: (*Server).shelfMutation},
	{method: "GET", path: "/api/mail", label: "/api/mail", handler: (*Server).mailRead},
	{method: "POST", path: "/api/mail", label: "/api/mail", handler: (*Server).mailSend},
	{method: "GET", path: "/api/projects", label: "/api/projects", handler: (*Server).projectsRead},
	{method: "GET", path: "/api/library", label: "/api/library", handler: (*Server).libraryRead},
	{method: "POST", path: "/api/library/donate", label: "/api/library/donate", handler: (*Server).libraryDonate},
	{method: "POST", path: "/api/wilds/claim", label: "/api/wilds/claim", handler: (*Server).wildsClaim},
	{method: "POST", path: "/api/wilds/lantern", label: "/api/wilds/lantern", handler: (*Server).wildsRelight},
	{method: "POST", path: "/api/wilds/clear", label: "/api/wilds/clear", handler: (*Server).wildsClear},
	{method: "POST", path: "/api/wilds/lay", label: "/api/wilds/lay", handler: (*Server).wildsLay},
	{method: "POST", path: "/api/wilds/lift", label: "/api/wilds/lift", handler: (*Server).wildsLift},
	{method: "POST", path: "/api/wilds/discover", label: "/api/wilds/discover", handler: (*Server).wildsDiscover},
	{method: "GET", path: "/api/camps", label: "/api/camps", handler: (*Server).campsRead},
	{method: "POST", path: "/api/camps", label: "/api/camps", handler: (*Server).campOp},
	{method: "GET", path: "/api/recovery", label: "/api/recovery", handler: (*Server).recoveryRead},
	{method: "GET", path: "/api/lamp-notices", label: "/api/lamp-notices", handler: (*Server).lampNoticesRead},
	{method: "POST", path: "/api/recovery/collect", label: "/api/recovery/collect", handler: (*Server).recoveryCollect},
	{method: "GET", path: "/api/communal-lamps", label: "/api/communal-lamps", handler: (*Server).communalLampsRead},
	{method: "POST", path: "/api/communal-lamps", label: "/api/communal-lamps", handler: (*Server).communalLampOp},
	{method: "GET", path: "/api/lamp-landmarks/", prefix: true, label: "/api/lamp-landmarks/:lamp", handler: (*Server).lampLandmarksRead},
	{method: "GET", path: "/api/ways-home", label: "/api/ways-home", handler: (*Server).waysHomeRead},
	{method: "POST", path: "/api/ways-home", label: "/api/ways-home", handler: (*Server).waysHomeOp},
	{method: "POST", path: "/api/wilds/echo", label: "/api/wilds/echo", handler: (*Server).settleEcho},
	{method: "POST", path: "/api/homestead/buy", label: "/api/homestead/buy", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/place", label: "/api/homestead/place", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/remove", label: "/api/homestead/remove", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/move", label: "/api/homestead/move", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/upgrade", label: "/api/homestead/upgrade", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/claim", label: "/api/homestead/claim", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/clear", label: "/api/homestead/clear", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/invite", label: "/api/homestead/invite", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/joint", label: "/api/homestead/joint", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/leave", label: "/api/homestead/leave", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/homestead/lantern", label: "/api/homestead/lantern", handler: (*Server).homeMutation},
	{method: "POST", path: "/api/spend", label: "/api/spend", handler: (*Server).spendOp},
	{method: "GET", path: "/api/items", label: "/api/items", handler: (*Server).itemsRead},
	{method: "POST", path: "/api/items/use", label: "/api/items/use", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/repair", label: "/api/items/repair", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/fit", label: "/api/items/fit", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/unfit", label: "/api/items/unfit", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/give", label: "/api/items/give", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/pocket", label: "/api/items/pocket", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/offhand", label: "/api/items/offhand", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/pickup", label: "/api/items/pickup", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/return", label: "/api/items/return", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/heirloom", label: "/api/items/heirloom", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/ada-oil", label: "/api/items/ada-oil", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/gather", label: "/api/items/gather", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/plant", label: "/api/items/plant", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/uproot", label: "/api/items/uproot", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/buy", label: "/api/items/buy", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/tap", label: "/api/items/tap", handler: (*Server).itemsMutation},
	{method: "POST", path: "/api/items/refine", label: "/api/items/refine", handler: (*Server).itemsMutation},
	{method: "GET", path: "/api/repairs", label: "/api/repairs", handler: (*Server).repairsRead},
	{method: "POST", path: "/api/fishing/cast", label: "/api/fishing/cast", handler: (*Server).fishCast},
	{method: "POST", path: "/api/fishing/settle", label: "/api/fishing/settle", handler: (*Server).fishSettle},
	{method: "POST", path: "/api/fishing/cancel", label: "/api/fishing/cancel", handler: (*Server).fishCancel},
	{method: "GET", path: "/api/fishing/waters", label: "/api/fishing/waters", handler: (*Server).fishingWaters},
	{method: "POST", path: "/api/companions", label: "/api/companions", handler: (*Server).companions},
	{method: "GET", path: "/api/wardrobe", label: "/api/wardrobe", handler: (*Server).wardrobeRead},
	{method: "POST", path: "/api/wardrobe", label: "/api/wardrobe", handler: (*Server).wardrobeMutation},
	{method: "POST", path: "/api/stable/stall", label: "/api/stable/stall", handler: (*Server).stableStall},
	{method: "POST", path: "/api/stable/out", label: "/api/stable/out", handler: (*Server).mountOut},
	{method: "POST", path: "/api/stable/home", label: "/api/stable/home", handler: (*Server).mountHome},
	{method: "POST", path: "/api/stable/extend", label: "/api/stable/extend", handler: (*Server).stableExtend},
	{method: "POST", path: "/api/mail/", suffix: "/recall", prefix: true, label: "/api/mail/:id/recall", handler: (*Server).mailRecall},
	{method: "POST", path: "/api/mail/", prefix: true, label: "/api/mail/:id/claim", handler: (*Server).mailClaim},
	{method: "POST", path: "/api/projects/", prefix: true, label: "/api/projects/:id/contribute", handler: (*Server).projectContribute},
	{method: "POST", path: "/api/repairs/", suffix: "/mend", prefix: true, label: "/api/repairs/:id/mend", handler: (*Server).repairMend},
	{method: "DELETE", path: "/api/invites/", prefix: true, label: "/api/invites/:id", handler: (*Server).revokeInvite},
	{method: "GET", path: "/api/homestead/land/", prefix: true, label: "/api/homestead/land/:gate", handler: (*Server).landRead},
	{method: "GET", path: "/api/homestead/", prefix: true, label: "/api/homestead/:gate", handler: (*Server).homeRead},
	{method: "GET", path: "/api/wilds/chunk/", prefix: true, label: "/api/wilds/chunk/:epoch/:layer/:cx/:cy", handler: (*Server).chunkRead},
	{method: "POST", path: "/api/wilds/map", label: "/api/wilds/map", handler: (*Server).mapStatusRead},
	{method: "GET", path: "/api/wilds/near/", prefix: true, label: "/api/wilds/near/:cx/:cy", handler: (*Server).nearRead},
	{method: "GET", path: "/api/sprites/", prefix: true, label: "/api/sprites/:name", handler: (*Server).sprite},
	{method: "HEAD", path: "/api/sprites/", prefix: true, label: "/api/sprites/:name", handler: (*Server).sprite},
}

func routeFor(method, path string) *routeMetadata {
	for i := range routes {
		route := &routes[i]
		if method != route.method {
			continue
		}
		if (!route.prefix && path == route.path) || (route.prefix && strings.HasPrefix(path, route.path) && strings.HasSuffix(path, route.suffix)) {
			return route
		}
	}
	return nil
}
func (a *Server) health(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := a.Store.DB.PingContext(ctx); err != nil {
		a.logUnexpected("/api/health", err)
		return fail(503, "internal")
	}
	if r.Method == "HEAD" {
		w.WriteHeader(http.StatusOK)
		return nil
	}
	result := map[string]string{"status": "ok", "version": cmp.Or(a.Config.Version, "dev")}
	if a.Config.Build != "" {
		result["build"] = a.Config.Build
	}
	write(w, 200, result)
	return nil
}
func (a *Server) calendar(w http.ResponseWriter, r *http.Request) error {
	writeProto(w, 200, calendarResponse(content.CalendarAt(content.CalendarRules, a.requestTime(r.Context()).Unix())))
	return nil
}
