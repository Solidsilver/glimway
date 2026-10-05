package content

import (
	"encoding/json"
	"fmt"
)

type Mail struct {
	MaxOutstandingSent         int `json:"maxOutstandingSent"`
	MaxOutstandingReceived     int `json:"maxOutstandingReceived"`
	MaxSendsPerWindow          int `json:"maxSendsPerWindow"`
	SendWindowSeconds          int `json:"sendWindowSeconds"`
	HistoryPageSize            int `json:"historyPageSize"`
	ReturnAfterDays            int `json:"returnAfterDays"`
	MaintenanceBatch           int `json:"maintenanceBatch"`
	MaintenanceIntervalSeconds int `json:"maintenanceIntervalSeconds"`
}

func ValidateMail(m Mail) error {
	for _, bound := range []struct{ value, max int }{
		{m.MaxOutstandingSent, 100}, {m.MaxOutstandingReceived, 100}, {m.MaxSendsPerWindow, 100},
		{m.SendWindowSeconds, 86400}, {m.HistoryPageSize, 100}, {m.ReturnAfterDays, 365},
		{m.MaintenanceBatch, 500}, {m.MaintenanceIntervalSeconds, 3600},
	} {
		if bound.value < 1 || bound.value > bound.max {
			return fmt.Errorf("invalid mail rules")
		}
	}
	return nil
}
func LoadMail() (Mail, error) {
	var m Mail
	raw, err := FS.ReadFile("mail.json")
	if err == nil {
		err = json.Unmarshal(raw, &m)
	}
	if err == nil {
		err = ValidateMail(m)
	}
	return m, err
}

var MailRules = func() Mail {
	m, err := LoadMail()
	if err != nil {
		panic(err)
	}
	return m
}()
