package api

import "net/http"

// The open map's routes (docs/design/open-map.md 2.4, 2.10, section 3), as
// contract 8 names them. Lane O-A settled their messages; lane O-C builds
// them. Until then each refuses with "not-implemented", so a client that
// calls one early learns nothing is wrong with its request.
//
//	GET  /api/wilds/near/<cx>/<cy>  -> WildsNearResult
//	POST /api/wilds/clear           WildsClearRequest    -> Envelope.wilds_clear
//	POST /api/wilds/lay             WildsLayRequest      -> Envelope.wilds_lay
//	POST /api/wilds/lift            WildsLiftRequest     -> Envelope.wilds_lift
//	POST /api/wilds/discover        WildsDiscoverRequest -> Envelope.wilds_discover

// nearRead is GET /api/wilds/near/<cx>/<cy>. Stub for lane O-C.
func (a *Server) nearRead(w http.ResponseWriter, r *http.Request) error {
	return fail(501, "not-implemented")
}

// wildsClear is POST /api/wilds/clear. Stub for lane O-C.
func (a *Server) wildsClear(w http.ResponseWriter, r *http.Request) error {
	return fail(501, "not-implemented")
}

// wildsLay is POST /api/wilds/lay. Stub for lane O-C.
func (a *Server) wildsLay(w http.ResponseWriter, r *http.Request) error {
	return fail(501, "not-implemented")
}

// wildsLift is POST /api/wilds/lift. Stub for lane O-C.
func (a *Server) wildsLift(w http.ResponseWriter, r *http.Request) error {
	return fail(501, "not-implemented")
}

// wildsDiscover is POST /api/wilds/discover. Stub for lane O-C.
func (a *Server) wildsDiscover(w http.ResponseWriter, r *http.Request) error {
	return fail(501, "not-implemented")
}
