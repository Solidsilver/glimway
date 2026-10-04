// Package habitica provides the server's only upstream call: proof at login.
package habitica

import (
	"context"
	"encoding/json"
	"errors"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
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
}

func (e *Error) Error() string { return e.Code }
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
func (c *Client) Verify(ctx context.Context, id, token string) (rules.Profile, error) {
	var zero rules.Profile
	u := strings.TrimRight(c.BaseURL, "/") + "/api/v3/user?userFields=" + url.QueryEscape("stats,profile.name,flags.classSelected,items.gear.equipped,items.gear.costume,items.pets,items.mounts,items.currentPet,items.currentMount,preferences")
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return zero, &Error{Code: "habitica-unavailable", Status: 502}
		}
		req.Header.Set("X-Api-User", id)
		req.Header.Set("X-Api-Key", token)
		req.Header.Set("X-Client", c.XClient)
		req.Header.Set("Accept", "application/json")
		res, err := c.HTTP.Do(req)
		if err != nil {
			return zero, &Error{Code: "habitica-unavailable", Status: 502}
		}
		if res.StatusCode == 429 {
			delay := retryAfter(res.Header.Get("Retry-After"))
			res.Body.Close()
			if attempt == 1 {
				return zero, &Error{Code: "habitica-rate-limited", Status: 429, RetryAfter: delay}
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return zero, &Error{Code: "habitica-unavailable", Status: 502}
			case <-timer.C:
			}
			continue
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			if res.StatusCode == 401 || res.StatusCode == 403 {
				return zero, &Error{Code: "habitica-auth", Status: 401}
			}
			return zero, &Error{Code: "habitica-unavailable", Status: 502}
		}
		b, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
		res.Body.Close()
		if err != nil {
			return zero, &Error{Code: "habitica-invalid-response", Status: 502}
		}
		p, err := Map(b)
		if err != nil || p.ID != id {
			return zero, &Error{Code: "habitica-invalid-response", Status: 502}
		}
		return p, nil
	}
	return zero, errors.New("habitica-unavailable")
}

var gear = func() map[string]content.GearItem {
	g, err := content.LoadGear()
	if err != nil {
		panic(err)
	}
	return g
}()

func Map(b []byte) (rules.Profile, error) {
	var payload struct {
		Success *bool `json:"success"`
		Data    struct {
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
				Pets         map[string]float64 `json:"pets"`
				Mounts       map[string]bool    `json:"mounts"`
				CurrentPet   *string            `json:"currentPet"`
				CurrentMount *string            `json:"currentMount"`
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
	p := rules.Profile{ID: u.ID, Name: u.Profile.Name, Level: *s.Level, Exp: s.Exp, HP: *s.HP, MP: *s.MP, MaxHP: 50, Equipped: u.Items.Gear.Equipped, Costume: u.Items.Gear.Costume, Pets: []string{}, Mounts: []string{}, SelectedPet: u.Items.CurrentPet, SelectedMount: u.Items.CurrentMount}
	if p.ID == "" {
		p.ID = u.AltID
	}
	if p.Exp == nil {
		n := 0.
		p.Exp = &n
	}
	if s.MaxHealth != nil {
		p.MaxHP = *s.MaxHealth
	}
	if u.Flags.ClassSelected == nil || *u.Flags.ClassSelected {
		p.Class = &s.Class
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
		if p.Class != nil && (g.Klass == *p.Class || g.SpecialClass == *p.Class) {
			m = 2
		}
		p.Stats.Str += m * g.Str
		p.Stats.Int += m * g.Int
		p.Stats.Con += m * g.Con
		p.Stats.Per += m * g.Per
	}
	p.MaxMP = 2*p.Stats.Int + 30

	for k, v := range u.Items.Pets {
		if v != 0 {
			p.Pets = append(p.Pets, k)
		}
	}
	for k, v := range u.Items.Mounts {
		if v {
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
	if !rules.ValidProfile(p) || p.Level > 100 || p.Level != math.Floor(p.Level) {
		return rules.Profile{}, bad
	}
	return p, nil
}
