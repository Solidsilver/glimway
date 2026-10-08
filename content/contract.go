package content

import "encoding/json"

// ContractNumber changes when an old client must reload before using the API.
var ContractNumber = func() int {
	raw, err := FS.ReadFile("contract.json")
	if err != nil {
		panic(err)
	}
	var c struct {
		Number int `json:"number"`
	}
	if err = json.Unmarshal(raw, &c); err != nil {
		panic(err)
	}
	if c.Number < 1 {
		panic("invalid contract number")
	}
	return c.Number
}()
