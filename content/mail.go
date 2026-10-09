package content

import contentv1 "glimway/gen/glimway/content/v1"

// Mail pacing rules (content/mail.json): the server's send, history and
// maintenance limits. The schema and its bounds live in
// proto/glimway/content/v1/mail.proto; there are no rules left in code.
type Mail = contentv1.Mail

// DecodeMail reads mail JSON into the generated types, refusing nulls and
// unknown keys, then runs the schema's rules (protovalidate).
func DecodeMail(raw []byte) (*Mail, error) {
	doc := &Mail{}
	if err := decodeContentProto(raw, "mail", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("mail", nil, doc)
}

func LoadMail() (*Mail, error) {
	raw, err := FS.ReadFile("mail.json")
	if err != nil {
		return nil, err
	}
	return DecodeMail(raw)
}

var MailRules = func() *Mail {
	m, err := LoadMail()
	if err != nil {
		panic(err)
	}
	return m
}()
