package content

import contentv1 "glimway/gen/glimway/content/v1"

type Enemies = contentv1.Enemies

func DecodeEnemies(raw []byte) (*Enemies, error) {
	doc := &Enemies{}
	if err := decodeContentProto(raw, "enemies", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("enemies", nil, doc)
}
func LoadEnemies() (*Enemies, error) {
	raw, err := FS.ReadFile("enemies.json")
	if err != nil {
		return nil, err
	}
	return DecodeEnemies(raw)
}

var EnemyRules = func() *Enemies {
	doc, err := LoadEnemies()
	if err != nil {
		panic(err)
	}
	return doc
}()
