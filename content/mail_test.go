package content

import "testing"

func TestMailContent(t *testing.T) {
	m, err := LoadMail()
	if err != nil || m.MaxOutstandingSent != 50 || m.MaxOutstandingReceived != 50 || m.MaxSendsPerWindow != 10 || m.ReturnAfterDays != 30 || m.HistoryPageSize != 50 {
		t.Fatal("mail defaults", err)
	}
	for _, mutate := range []func(*Mail){func(m *Mail) { m.MaxOutstandingSent = 0 }, func(m *Mail) { m.MaxOutstandingReceived = 101 }, func(m *Mail) { m.MaxSendsPerWindow = 0 }, func(m *Mail) { m.SendWindowSeconds = 86401 }, func(m *Mail) { m.HistoryPageSize = 101 }, func(m *Mail) { m.ReturnAfterDays = 366 }, func(m *Mail) { m.MaintenanceBatch = 501 }, func(m *Mail) { m.MaintenanceIntervalSeconds = 3601 }} {
		copy := m
		mutate(&copy)
		if ValidateMail(copy) == nil {
			t.Fatal("accepted invalid mail limits")
		}
	}
}
