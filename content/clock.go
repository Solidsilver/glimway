package content

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"time"
)

type Festival struct {
	Name string `json:"name"`
	Wick string `json:"wick"`
	Day  int    `json:"day"`
}
type Calendar struct {
	Epoch     string     `json:"epoch"`
	WickDays  int        `json:"wickDays"`
	Wicks     []string   `json:"wicks"`
	Marks     []string   `json:"marks"`
	Festivals []Festival `json:"festivals"`
}

func ValidateCalendar(c Calendar) error {
	t, err := time.Parse(time.RFC3339, c.Epoch)
	if err != nil || t.Format("2006-01-02T15:04:05Z07:00") != c.Epoch || t.UTC().Hour() != 0 || t.UTC().Minute() != 0 || t.UTC().Second() != 0 || c.WickDays < 7 || c.WickDays > 365 || !slices.Equal(c.Wicks, []string{"Thaw", "Mud", "Bud", "Bloom", "Light", "Cart", "Haze", "Sap", "Amber", "Leaf", "Smoke", "Quiet"}) || !slices.Equal(c.Marks, []string{"Mudrise", "Mudrise", "Mudrise", "Carting", "Carting", "Carting", "Amberfall", "Amberfall", "Amberfall", "Quiet", "Quiet", "Quiet"}) || len(c.Festivals) != 4 {
		return fmt.Errorf("invalid calendar")
	}
	seen := map[string]bool{}
	for _, f := range c.Festivals {
		if f.Name == "" || seen[f.Name] || !slices.Contains(c.Wicks, f.Wick) || f.Day < 1 || f.Day > c.WickDays {
			return fmt.Errorf("invalid calendar festival")
		}
		seen[f.Name] = true
	}
	return nil
}
func LoadCalendar() (Calendar, error) {
	var c Calendar
	b, err := FS.ReadFile("clock.json")
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	if err == nil {
		err = ValidateCalendar(c)
	}
	return c, err
}

var CalendarRules = func() Calendar {
	c, err := LoadCalendar()
	if err != nil {
		panic(err)
	}
	return c
}()

type CalendarDay struct {
	Wick        string  `json:"wick"`
	WickNumber  int64   `json:"wickNumber"`
	Year        int64   `json:"year"`
	Day         int     `json:"day"`
	Mark        string  `json:"mark"`
	Festival    *string `json:"festival"`
	StartsAt    int64   `json:"startsAt"`
	NextTurning int64   `json:"nextTurning"`
	Notice      *string `json:"notice"`
	WickDays    int     `json:"wickDays"`
}

func floorDiv(n, d int64) int64 {
	q := n / d
	if n%d < 0 {
		q--
	}
	return q
}

// CalendarAt is pure and takes Unix seconds, as does the TypeScript pair.
func CalendarAt(c Calendar, unix int64) CalendarDay {
	epoch, _ := time.Parse(time.RFC3339, c.Epoch)
	duration := int64(c.WickDays) * 86400
	index := floorDiv(unix-epoch.Unix(), duration)
	w := int(index - floorDiv(index, 12)*12)
	start := epoch.Unix() + index*duration
	out := CalendarDay{Wick: c.Wicks[w], WickNumber: index + 1, Year: floorDiv(index, 12) + 1, Day: int((unix-start)/86400) + 1, Mark: c.Marks[w], StartsAt: start, NextTurning: start + duration, WickDays: c.WickDays}
	for _, f := range c.Festivals {
		if f.Wick == out.Wick && f.Day == out.Day {
			name := f.Name
			out.Festival = &name
		}
	}
	if out.NextTurning-unix <= 86400 {
		notice := fmt.Sprintf("Dark of %s-wick — the outer Wilds will turn.", out.Wick)
		out.Notice = &notice
	}
	return out
}

// Recovered bounds elapsed recovery using Unix seconds, including fractional times.
func Recovered(stored, rate, cap, since, now float64) float64 {
	return math.Min(cap, stored+rate*math.Max(0, now-since))
}
func NextTurning(c Calendar, now int64) int64 { return CalendarAt(c, now).NextTurning }
