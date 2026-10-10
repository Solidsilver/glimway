// Package habitica is the server's only upstream: Habitica. Three kinds of
// request leave this package, and each carries the player's token in one
// request header and drops it when the call returns — the token is never
// stored, logged, hashed, or put in a body or an error.
//
//   - Proof at sign-in (VerifyLimited), a read; the wardrobe's owned gear
//     comes back with it (design 4.3).
//   - The purse's reads (Gold, OwnedGear): what the player has there. The
//     wardrobe's "Check for new gear" is one OwnedGear read.
//   - The purse's writes (CreateReward, ScoreDown, DeleteTask), and only
//     during a top-up the player consented to: a reward named "Glimway
//     purse" is added to their Habitica Rewards, bought once — scored
//     **down**, never up, so no drop and no achievement can roll — and
//     removed. Gold leaves Habitica; nothing ever goes back (2.2).
//
// Every failure is a coded *Error: a status and a code word, never a body.
// The browser's own Habitica client (src/lib/habitica) stays read-only; this
// package is the only place that writes, and it writes for a top-up alone.
package habitica

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"glimway/content"
	"glimway/server/internal/rules"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	BaseURL, XClient string
	HTTP             *http.Client
}
type Error struct {
	Code       string
	Status     int
	RetryAfter time.Duration
	// Sent says the request reached Habitica — or may have: a transport
	// failure is "sent", because we don't know what it did. Only our own
	// budget refusing a call is "not sent": nothing left the server, so
	// nothing was charged, and the top-up must not count it as an unknown
	// outcome (2.2 step d).
	Sent bool
}

func (e *Error) Error() string { return e.Code }

// NotSent is the budget's own refusal: the call never went out.
func (e *Error) NotSent() bool { return !e.Sent }

// Upstream is the narrow slice of Habitica the server calls (design 2.7):
// the sign-in proof and the purse's four calls, behind an interface so tests
// inject "the score timed out after Habitica ran it" and the rest. Every
// method takes the token for that one call and must drop it afterwards.
type Upstream interface {
	VerifyLimited(ctx context.Context, id, token string, allow func() bool) (rules.Profile, []string, error)
	Gold(ctx context.Context, id, token string, allow func() bool) (Gold, error)
	OwnedGear(ctx context.Context, id, token string, allow func() bool) (string, []string, error)
	CreateReward(ctx context.Context, id, token string, task Reward, allow func() bool) error
	ScoreDown(ctx context.Context, id, token, alias string, allow func() bool) (int, error)
	DeleteTask(ctx context.Context, id, token, alias string, allow func() bool) error
}

// Gold is one purse read (2.2 step b): the player's Habitica gold, floored,
// and the gear they own. ID is the user's _id — the caller checks it is the
// account's Habitica subject.
type Gold struct {
	ID    string
	Gold  int
	Owned []string
}

// Reward is the "Glimway purse" reward a top-up adds to the player's
// Habitica Rewards for a moment (2.2 step c). Value is the amount in gold;
// Alias is glimway-topup-<top-up id>, so the task can be found, scored and
// removed by name.
type Reward struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	Notes string `json:"notes"`
	Value int    `json:"value"`
	Alias string `json:"alias"`
}

func New(base, tag string) *Client {
	return &Client{base, tag, &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func retryAfter(v string) time.Duration {
	if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 0 && !math.IsInf(n, 0) {
		return time.Duration(math.Min(n, 60) * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		return min(max(time.Until(t), 0), 60*time.Second)
	}
	return time.Second
}

// VerifyLimited is the sign-in's one network call: the login server's shared
// limiter gates it, including retries. It returns the mapped profile and the
// gear the player owns (items.gear.owned, 4.3) — only the server's own reads
// may fill player_gear, and this is one of the three.
func (c *Client) VerifyLimited(ctx context.Context, id, token string, allow func() bool) (rules.Profile, []string, error) {
	var zero rules.Profile
	u := strings.TrimRight(c.BaseURL, "/") + "/api/v3/user?userFields=" + url.QueryEscape("stats,profile.name,flags.classSelected,items.gear.equipped,items.gear.costume,items.gear.owned,items.pets,items.mounts,items.currentPet,items.currentMount,preferences,party._id")
	// Every attempt answers: only a 429 on the first one tries again.
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return zero, nil, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
		}
		req.Header.Set("X-Api-User", id)
		req.Header.Set("X-Api-Key", token)
		req.Header.Set("X-Client", c.XClient)
		req.Header.Set("Accept", "application/json")
		if allow != nil && !allow() {
			return zero, nil, &Error{Code: "login-global-rate-limited", Status: 429, RetryAfter: time.Minute}
		}
		res, err := c.HTTP.Do(req)
		if err != nil {
			return zero, nil, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
		}
		if res.StatusCode == 429 {
			delay := retryAfter(res.Header.Get("Retry-After"))
			res.Body.Close()
			if attempt == 1 {
				return zero, nil, &Error{Code: "habitica-rate-limited", Status: 429, RetryAfter: delay, Sent: true}
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return zero, nil, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
			case <-timer.C:
			}
			continue
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			if res.StatusCode == 401 || res.StatusCode == 403 {
				return zero, nil, &Error{Code: "habitica-auth", Status: 401, Sent: true}
			}
			return zero, nil, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
		}
		b, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
		res.Body.Close()
		if err != nil {
			return zero, nil, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
		}
		p, err := Map(b)
		if err != nil || p.ID != id {
			return zero, nil, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
		}
		return p, ownedGear(b), nil
	}
}

// -------------------------------------------------------------- the purse's calls
//
// The four calls a top-up makes (2.2) and the wardrobe's one read (4.3),
// each returning a coded *Error and never a body. They share one request
// shape: the token in X-Api-Key for this call alone, the creator tag in
// X-Client, redirects off, and the caller's timeout.

// call is that shared shape. It returns the response's status, body and
// Retry-After, and a coded error only for a refused budget or a transport
// failure: every method below reads the status itself, because the same
// status means different things to different calls (a 401 on a score is
// "Not Enough Gold" as often as a bad token).
func (c *Client) call(ctx context.Context, method, path, id, token string, payload []byte, allow func() bool) (int, []byte, time.Duration, *Error) {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, body)
	if err != nil {
		return 0, nil, time.Second, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
	}
	req.Header.Set("X-Api-User", id)
	req.Header.Set("X-Api-Key", token)
	req.Header.Set("X-Client", c.XClient)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if allow != nil && !allow() {
		return 0, nil, time.Minute, &Error{Code: "login-global-rate-limited", Status: 429, RetryAfter: time.Minute}
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, time.Second, &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
	}
	defer res.Body.Close()
	retry := retryAfter(res.Header.Get("Retry-After"))
	b, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return res.StatusCode, nil, retry, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
	}
	return res.StatusCode, b, retry, nil
}

// readError maps a read's non-200 onto a coded error (401 and 403 are a
// refused token; 429 carries the wait it asked for; anything else is
// Habitica being down). A read is never retried here: only the sign-in's
// VerifyLimited retries, and only the score has its own one retry (2.2).
func readError(status int, body []byte, retry time.Duration) *Error {
	switch {
	case status == 401 || status == 403:
		return &Error{Code: "habitica-auth", Status: 401, Sent: true}
	case status == 429:
		return &Error{Code: "habitica-rate-limited", Status: 429, RetryAfter: retry, Sent: true}
	case status >= 500:
		return &Error{Code: "habitica-unavailable", Status: 502, Sent: true}
	default:
		// A 4xx Habitica answered: it saw the request and said no. Nothing
		// was created or charged — the opposite of a timeout, which is what
		// finding 9's leftover mark turns on.
		return &Error{Code: "invalid-request", Status: 400, Sent: true}
	}
}

// userRead is one GET /api/v3/user for a few fields, returning the data
// object's raw bytes. The caller reads what it asked for and nothing else.
func (c *Client) userRead(ctx context.Context, id, token, fields string, allow func() bool) ([]byte, *Error) {
	status, b, retry, e := c.call(ctx, "GET", "/api/v3/user?userFields="+url.QueryEscape(fields), id, token, nil, allow)
	if e != nil {
		return nil, e
	}
	if status != 200 {
		return nil, readError(status, b, retry)
	}
	var payload struct {
		Success *bool           `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(b, &payload) != nil || payload.Success != nil && !*payload.Success || len(payload.Data) == 0 {
		return nil, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
	}
	return payload.Data, nil
}

// Gold is the purse's own read (2.2 step b): the gold the player has on
// Habitica, floored, and the gear they own. The account's subject is the
// user's _id — the caller refuses a mismatch.
func (c *Client) Gold(ctx context.Context, id, token string, allow func() bool) (Gold, error) {
	data, e := c.userRead(ctx, id, token, "stats.gp,items.gear.owned", allow)
	if e != nil {
		return Gold{}, e
	}
	var user struct {
		ID    string `json:"_id"`
		AltID string `json:"id"`
		Stats struct {
			GP *float64 `json:"gp"`
		} `json:"stats"`
		Items json.RawMessage `json:"items"`
	}
	if json.Unmarshal(data, &user) != nil {
		return Gold{}, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
	}
	if user.ID == "" {
		user.ID = user.AltID
	}
	gold := 0
	if user.Stats.GP != nil && *user.Stats.GP > 0 {
		gold = int(math.Floor(*user.Stats.GP))
	}
	return Gold{ID: user.ID, Gold: gold, Owned: ownedGear(data)}, nil
}

// OwnedGear is "Check for new gear" (4.3): one read of items.gear.owned.
// The wardrobe's list is never taken from a browser report. It answers the
// user's _id too — the caller refuses one that isn't the account's subject.
func (c *Client) OwnedGear(ctx context.Context, id, token string, allow func() bool) (string, []string, error) {
	data, e := c.userRead(ctx, id, token, "items.gear.owned", allow)
	if e != nil {
		return "", nil, e
	}
	var user struct {
		ID    string `json:"_id"`
		AltID string `json:"id"`
	}
	if json.Unmarshal(data, &user) != nil {
		return "", nil, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
	}
	if user.ID == "" {
		user.ID = user.AltID
	}
	return user.ID, ownedGear(data), nil
}

// ownedGear reads items.gear.owned out of a user object — or out of the
// response body that wraps one in "data" (VerifyLimited reads the body, the
// purse's reads the data): the sorted keys whose value is true (false is
// gear the player had and lost, 4.3), kept only while the catalog knows
// them — an unknown key can't be drawn.
func ownedGear(data []byte) []string {
	var user struct {
		Data  json.RawMessage `json:"data"`
		Items struct {
			Gear struct {
				Owned map[string]bool `json:"owned"`
			} `json:"gear"`
		} `json:"items"`
	}
	if json.Unmarshal(data, &user) != nil {
		return nil
	}
	if user.Items.Gear.Owned == nil && len(user.Data) > 0 {
		return ownedGear(user.Data)
	}
	out := []string{}
	for key, owned := range user.Items.Gear.Owned {
		if owned {
			if _, known := gear[key]; known {
				out = append(out, key)
			}
		}
	}
	sort.Strings(out)
	return out
}

// CreateReward adds the "Glimway purse" reward to the player's Habitica
// Rewards (2.2 step c). A failure here is never a charge: nothing has been
// scored yet.
func (c *Client) CreateReward(ctx context.Context, id, token string, task Reward, allow func() bool) error {
	payload, err := json.Marshal(task)
	if err != nil {
		return err
	}
	status, b, retry, e := c.call(ctx, "POST", "/api/v3/tasks/user", id, token, payload, allow)
	if e != nil {
		return e
	}
	if status == 201 {
		return nil
	}
	return readError(status, b, retry)
}

// ScoreDown buys that reward once: POST /api/v3/tasks/:alias/score/down.
// **Down, never up** — scoring up can roll a drop and award an achievement,
// which would grant a Habitica item. The caller sends it at most twice (its
// one 429 retry) and **never again after an unknown outcome** (2.2 step d).
// It answers the gold Habitica reports after the charge, floored.
func (c *Client) ScoreDown(ctx context.Context, id, token, alias string, allow func() bool) (int, error) {
	status, b, retry, e := c.call(ctx, "POST", "/api/v3/tasks/"+url.PathEscape(alias)+"/score/down", id, token, []byte("{}"), allow)
	if e != nil {
		return 0, e
	}
	if status == 200 {
		var payload struct {
			Data struct {
				GP *float64 `json:"gp"`
			} `json:"data"`
		}
		if json.Unmarshal(b, &payload) != nil || payload.Data.GP == nil {
			return 0, &Error{Code: "habitica-invalid-response", Status: 502, Sent: true}
		}
		return int(math.Floor(*payload.Data.GP)), nil
	}
	if status == 401 && notEnoughGold(b) {
		// Habitica's own "Not Enough Gold": the reward was refused before
		// it was charged. Coded with the wire's word for it (insufficient-
		// gold), because every code this package returns is a wire code;
		// the caller settles the row `not-enough` and never puts it there.
		return 0, &Error{Code: "insufficient-gold", Status: 401, Sent: true}
	}
	if status == 429 {
		// Habitica refused before running it; the caller waits this long
		// (2.2 step d caps the wait at five seconds) and sends it once more.
		return 0, &Error{Code: "habitica-rate-limited", Status: 429, RetryAfter: retry, Sent: true}
	}
	return 0, readError(status, b, retry)
}

// notEnoughGold reads Habitica's own refusal for a reward the player can't
// afford — the one 401 that is not a bad token. Habitica answers it as
// `error: "NotAuthorized"` with a message in the **user's language**, so the
// error code is what matches; the English message is kept for whatever else
// spells it out. The text is read and dropped: nothing from a body is ever
// returned or stored.
func notEnoughGold(b []byte) bool {
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &payload) != nil {
		return false
	}
	if strings.EqualFold(payload.Error, "NotAuthorized") {
		return true
	}
	text := strings.ToLower(payload.Message)
	return strings.Contains(text, "not enough gold") || strings.Contains(text, "notenoughgold")
}

// DeleteTask removes the reward again (2.2 step e): after every create,
// whatever the outcome. 404 counts as done — there is nothing left to
// remove. A failure marks the row leftover, for the next top-up to clear.
func (c *Client) DeleteTask(ctx context.Context, id, token, alias string, allow func() bool) error {
	status, b, retry, e := c.call(ctx, "DELETE", "/api/v3/tasks/"+url.PathEscape(alias), id, token, nil, allow)
	if e != nil {
		return e
	}
	if status == 200 || status == 204 || status == 404 {
		return nil
	}
	return readError(status, b, retry)
}

// The one validated snapshot (content/habitica_gear.go): no second decode.
var gear = content.HabiticaGearRules.Gear

func Map(b []byte) (rules.Profile, error) {
	var payload struct {
		Success *bool `json:"success"`
		Data    struct {
			Party struct {
				ID *string `json:"_id"`
			} `json:"party"`
			ID      string `json:"_id"`
			AltID   string `json:"id"`
			Profile struct {
				Name string `json:"name"`
			} `json:"profile"`
			Flags struct {
				ClassSelected *bool `json:"classSelected"`
			} `json:"flags"`
			Stats struct {
				HP        *float64    `json:"hp"`
				MP        *float64    `json:"mp"`
				Level     *float64    `json:"lvl"`
				Exp       *float64    `json:"exp"`
				Class     string      `json:"class"`
				Str       *float64    `json:"str"`
				Int       *float64    `json:"int"`
				Con       *float64    `json:"con"`
				Per       *float64    `json:"per"`
				Buffs     rules.Stats `json:"buffs"`
				MaxHealth *float64    `json:"maxHealth"`
			} `json:"stats"`
			Items struct {
				Gear struct {
					Equipped map[string]*string `json:"equipped"`
					Costume  map[string]*string `json:"costume"`
				} `json:"gear"`
				Pets         map[string]json.RawMessage `json:"pets"`
				Mounts       map[string]json.RawMessage `json:"mounts"`
				CurrentPet   *string                    `json:"currentPet"`
				CurrentMount *string                    `json:"currentMount"`
			} `json:"items"`
			Preferences struct {
				Size       string          `json:"size"`
				Shirt      string          `json:"shirt"`
				Skin       string          `json:"skin"`
				Background string          `json:"background"`
				Costume    json.RawMessage `json:"costume"`
				Hair       struct {
					Color    string  `json:"color"`
					Base     float64 `json:"base"`
					Bangs    float64 `json:"bangs"`
					Mustache float64 `json:"mustache"`
					Beard    float64 `json:"beard"`
					Flower   float64 `json:"flower"`
				} `json:"hair"`
			} `json:"preferences"`
		} `json:"data"`
	}
	bad := errors.New("habitica-invalid-response")
	if json.Unmarshal(b, &payload) != nil || payload.Success != nil && !*payload.Success {
		return rules.Profile{}, bad
	}
	u := payload.Data
	s := u.Stats
	if s.HP == nil || s.MP == nil || s.Level == nil || s.Str == nil || s.Int == nil || s.Con == nil || s.Per == nil {
		return rules.Profile{}, bad
	}
	p := rules.Profile{PartyID: u.Party.ID, ID: u.ID, Name: u.Profile.Name, Level: *s.Level, Exp: s.Exp, HP: *s.HP, MP: *s.MP, MaxHP: 50, Equipped: u.Items.Gear.Equipped, Costume: u.Items.Gear.Costume, Pets: []string{}, Mounts: []string{}, SelectedPet: u.Items.CurrentPet, SelectedMount: u.Items.CurrentMount}
	if p.ID == "" {
		p.ID = u.AltID
	}
	if p.Exp != nil && *p.Exp < 0 {
		n := 0.
		p.Exp = &n
	}
	if p.Exp == nil {
		n := 0.
		p.Exp = &n
	}
	if s.MaxHealth != nil {
		p.MaxHP = *s.MaxHealth
	}
	if u.Flags.ClassSelected == nil || *u.Flags.ClassSelected {
		// Habitica reports the mage class as "wizard"; map it onto the
		// internal "mage" here so nothing downstream sees the alias.
		c, ok := rules.NormalizeClass(s.Class)
		if !ok {
			return rules.Profile{}, bad
		}
		p.Class = &c
	}
	bonus := math.Floor(math.Min(p.Level, 100) / 2)
	p.Stats = rules.Stats{Str: *s.Str + s.Buffs.Str + bonus, Int: *s.Int + s.Buffs.Int + bonus, Con: *s.Con + s.Buffs.Con + bonus, Per: *s.Per + s.Buffs.Per + bonus}
	for _, v := range p.Equipped {
		if v == nil {
			continue
		}
		g, ok := gear[*v]
		if !ok {
			continue
		}
		m := 1.
		if p.Class != nil && (rules.GearMatchesClass(g.GetKlass(), *p.Class) || rules.GearMatchesClass(g.GetSpecialClass(), *p.Class)) {
			m = 2
		}
		p.Stats.Str += m * g.Str
		p.Stats.Int += m * g.Int
		p.Stats.Con += m * g.Con
		p.Stats.Per += m * g.Per
	}
	p.MaxMP = 2*p.Stats.Int + 30

	for k, v := range u.Items.Pets {
		if ownedPet(v) {
			p.Pets = append(p.Pets, k)
		}
	}
	for k, v := range u.Items.Mounts {
		if ownedMount(v) {
			p.Mounts = append(p.Mounts, k)
		}
	}
	sort.Strings(p.Pets)
	sort.Strings(p.Mounts)
	prefs := u.Preferences
	h := prefs.Hair
	p.Appearance = rules.Appearance{Size: prefs.Size, Shirt: prefs.Shirt, Skin: prefs.Skin, HairColor: h.Color, HairStyle: h.Base, Background: prefs.Background, HairBangs: h.Bangs, HairMustache: h.Mustache, HairBeard: h.Beard, HairFlower: h.Flower}
	p.UseCostume = string(prefs.Costume) == "true" || string(prefs.Costume) == "1"
	if p.SelectedPet != nil && *p.SelectedPet == "" {
		p.SelectedPet = nil
	}
	if p.SelectedMount != nil && *p.SelectedMount == "" {
		p.SelectedMount = nil
	}
	p = rules.SanitizeProfile(p)
	if !rules.ValidProfile(p) || p.Level > rules.MaxProfileLevel || p.Level != math.Floor(p.Level) {
		return rules.Profile{}, bad
	}
	return p, nil
}

// Habitica may retain released pets/mounts as null. A pet is owned when its
// value is a number greater than 0: a pet raised into a mount is stored as
// -1 and is not an owned pet (docs/design/crafts.md 2.2). A mount is owned
// when its value is true. Other input kinds count as nothing.
func ownedPet(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	n, ok := value.(float64)
	return ok && n > 0
}

func ownedMount(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	b, ok := value.(bool)
	return ok && b
}
