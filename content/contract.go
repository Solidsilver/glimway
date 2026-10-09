package content

import (
	contentv1 "glimway/gen/glimway/content/v1"
)

type Contract = contentv1.Contract

// DecodeContract reads contract JSON into the generated type, refusing
// nulls and unknown keys, then runs the schema's rules. There are no rules
// left in code: the number is at least one on the schema.
func DecodeContract(raw []byte) (*Contract, error) {
	doc := &Contract{}
	if err := decodeContentProto(raw, "contract", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("contract", nil, doc)
}

func LoadContract() (*Contract, error) {
	raw, err := FS.ReadFile("contract.json")
	if err != nil {
		return nil, err
	}
	return DecodeContract(raw)
}

// ContractNumber changes when an old client must reload before using the API.
var ContractNumber = func() int {
	c, err := LoadContract()
	if err != nil {
		panic(err)
	}
	return int(c.GetNumber())
}()
