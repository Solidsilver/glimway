package content

import "fmt"

type Vitals struct {
	RegenCap         float64 `json:"regenCap"`
	FallHPFraction   float64 `json:"fallHpFraction"`
	FallManaFraction float64 `json:"fallManaFraction"`
	ReportGapCap     float64 `json:"reportGapCap"`
}

func LoadVitals() (Vitals, error) {
	var v Vitals
	if e := readTable("vitals.json", &v); e != nil {
		return v, e
	}
	if v.RegenCap <= 0 || v.FallHPFraction <= 0 || v.FallHPFraction > 1 || v.FallManaFraction <= 0 || v.FallManaFraction > 1 || v.ReportGapCap <= 0 {
		return v, fmt.Errorf("invalid vitals")
	}
	return v, nil
}

var VitalsRules = func() Vitals {
	v, e := LoadVitals()
	if e != nil {
		panic(e)
	}
	return v
}()
