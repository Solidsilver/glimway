package content

import (
	"fmt"
	"math"
	"slices"
	"time"

	contentv1 "glimway/gen/glimway/content/v1"
)

type (
	Calendar = contentv1.Calendar
	Festival = contentv1.Festival
)

// DecodeCalendar reads clock JSON into the generated type, refusing nulls
// and unknown keys, then runs the schema's rules and the calendar's own
// rule: one name per festival. The epoch's canonical spelling, the fixed
// wicks and marks, the festival count and each festival's wick and day are
// all on the schema.
func DecodeCalendar(raw []byte) (*Calendar, error) {
	doc := &Calendar{}
	if err := decodeContentProto(raw, "calendar", doc); err != nil {
		return doc, err
	}
	entries := make([]entryList, 1)
	entries[0] = entryList{field: "festivals", ids: make([]string, len(doc.GetFestivals()))}
	seen := map[string]bool{}
	for i, f := range doc.GetFestivals() {
		entries[0].ids[i] = f.GetName()
		if seen[entries[0].ids[i]] {
			return doc, fmt.Errorf("invalid calendar: duplicate festival %s", entries[0].ids[i])
		}
		seen[entries[0].ids[i]] = true
	}
	return doc, contentValidate("calendar", entries, doc)
}

func LoadCalendar() (*Calendar, error) {
	raw, err := FS.ReadFile("clock.json")
	if err != nil {
		return nil, err
	}
	return DecodeCalendar(raw)
}

var CalendarRules = func() *Calendar {
	c, err := LoadCalendar()
	if err != nil {
		panic(err)
	}
	return c
}()

// QuestWaitReady counts elapsed hours or calendar wick boundaries, not play time.
func QuestWaitReady(wait *QuestWait, since, now int64) bool {
	if now < since {
		return false
	}
	if wait.GetHours() > 0 {
		return float64(now)-float64(since) >= wait.GetHours()*3600
	}
	return CalendarAt(CalendarRules, now).WickNumber-CalendarAt(CalendarRules, since).WickNumber >= int64(wait.GetTurnings())
}

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
// It takes the calendar by pointer: proto messages are not copied.
func CalendarAt(c *Calendar, unix int64) CalendarDay {
	epoch, _ := time.Parse(time.RFC3339, c.GetEpoch())
	duration := int64(c.GetWickDays()) * 86400
	index := floorDiv(unix-epoch.Unix(), duration)
	w := int(index - floorDiv(index, 12)*12)
	start := epoch.Unix() + index*duration
	out := CalendarDay{Wick: c.GetWicks()[w], WickNumber: index + 1, Year: floorDiv(index, 12) + 1, Day: int((unix-start)/86400) + 1, Mark: c.GetMarks()[w], StartsAt: start, NextTurning: start + duration, WickDays: int(c.GetWickDays())}
	for _, f := range c.GetFestivals() {
		if f.GetWick() == out.Wick && int(f.GetDay()) == out.Day {
			name := f.GetName()
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
func NextTurning(c *Calendar, now int64) int64 { return CalendarAt(c, now).NextTurning }

// CycleAt is pure: phase intervals are half-open, with the offset measured
// from Unix zero. Modulo uses floor so times before the epoch wrap too.
type CyclePlace struct {
	Spot  string  `json:"spot"`
	Since float64 `json:"since"`
	Until float64 `json:"until"`
}

func CycleAt(resident *Resident, now float64) CyclePlace {
	period := float64(ResidentRules.GetPeriodMinutes() * 60)
	offset := float64(resident.GetOffsetMinutes() * 60)
	start := math.Floor((now-offset)/period)*period + offset
	for _, p := range resident.GetCycle() {
		until := start + float64(p.GetMinutes()*60)
		if now < until {
			return CyclePlace{p.GetSpot(), start, until}
		}
		start = until
	}
	panic("invalid resident cycle")
}

// CycleSpotsNear includes the current spot first, then previous and next
// during the inclusive grace window. A single-phase cycle appears only once.
func CycleSpotsNear(resident *Resident, now float64, graceSeconds int) []string {
	current := CycleAt(resident, now)
	out := []string{current.Spot}
	add := func(spot string) {
		if !slices.Contains(out, spot) {
			out = append(out, spot)
		}
	}
	if graceSeconds > 0 && now-current.Since <= float64(graceSeconds) {
		add(CycleAt(resident, current.Since-1).Spot)
	}
	if graceSeconds > 0 && current.Until-now <= float64(graceSeconds) {
		add(CycleAt(resident, current.Until).Spot)
	}
	return out
}
