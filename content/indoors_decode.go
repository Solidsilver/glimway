package content

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Required fields are checked before decoding so a missing tile coordinate or
// quantity cannot quietly become zero. Aliases below avoid recursive decoding.
func decodeContent(raw []byte, out any, required ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if fields == nil {
		return fmt.Errorf("invalid content object")
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return fmt.Errorf("missing content field %s", key)
		}
	}
	for key, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("null content field %s", key)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(out)
}
func (v *RoomTile) UnmarshalJSON(raw []byte) error {
	type plain RoomTile
	return decodeContent(raw, (*plain)(v), "tx", "ty")
}
func (v *RoomProp) UnmarshalJSON(raw []byte) error {
	type plain RoomProp
	return decodeContent(raw, (*plain)(v), "art", "char", "solid")
}
func (v *RoomSpot) UnmarshalJSON(raw []byte) error {
	type plain RoomSpot
	return decodeContent(raw, (*plain)(v), "tx", "ty", "label")
}
func (v *RoomLight) UnmarshalJSON(raw []byte) error {
	type plain RoomLight
	return decodeContent(raw, (*plain)(v), "tx", "ty", "kind", "r")
}
func (v *RoomDoor) UnmarshalJSON(raw []byte) error {
	type plain RoomDoor
	return decodeContent(raw, (*plain)(v), "id", "kind", "at", "side", "to", "entry")
}
func (v *Room) UnmarshalJSON(raw []byte) error {
	type plain Room
	return decodeContent(raw, (*plain)(v), "id", "name", "parent", "map", "doors", "props", "spots", "lights")
}
func (v *ResidentSpot) UnmarshalJSON(raw []byte) error {
	type plain ResidentSpot
	return decodeContent(raw, (*plain)(v), "area", "tx", "ty")
}
func (v *ResidentPhase) UnmarshalJSON(raw []byte) error {
	type plain ResidentPhase
	return decodeContent(raw, (*plain)(v), "spot", "minutes")
}
func (v *Resident) UnmarshalJSON(raw []byte) error {
	type plain Resident
	return decodeContent(raw, (*plain)(v), "id", "spots", "cycle")
}
func (v *QuestTrigger) UnmarshalJSON(raw []byte) error {
	type plain QuestTrigger
	if err := decodeContent(raw, (*plain)(v)); err != nil {
		return err
	}
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	if len(fields) != 1 {
		return fmt.Errorf("one quest trigger required")
	}
	for key, value := range fields {
		if key != "new" && value == "" {
			return fmt.Errorf("empty quest trigger")
		}
	}
	return nil
}
func (v *QuestWait) UnmarshalJSON(raw []byte) error {
	type plain QuestWait
	if err := decodeContent(raw, (*plain)(v)); err != nil {
		return err
	}
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	if len(fields) != 1 || v.Hours <= 0 && v.Turnings <= 0 {
		return fmt.Errorf("one positive quest wait required")
	}
	return nil
}
func (v *QuestGate) UnmarshalJSON(raw []byte) error {
	type plain QuestGate
	if err := decodeContent(raw, (*plain)(v)); err != nil {
		return err
	}
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	if _, ok := fields["embers"]; ok && v.Embers <= 0 {
		return fmt.Errorf("positive gate embers required")
	}
	if _, ok := fields["with"]; ok && v.With == "" {
		return fmt.Errorf("gate with required")
	}
	return nil
}
func (v *QuestWhere) UnmarshalJSON(raw []byte) error {
	type plain QuestWhere
	if err := decodeContent(raw, (*plain)(v)); err != nil {
		return err
	}
	var fields map[string]string
	_ = json.Unmarshal(raw, &fields)
	for _, value := range fields {
		if value == "" {
			return fmt.Errorf("empty quest where")
		}
	}
	return nil
}
func (v *QuestStep) UnmarshalJSON(raw []byte) error {
	type plain QuestStep
	return decodeContent(raw, (*plain)(v), "id", "at", "items", "marks", "papers", "embers", "witness", "do")
}

func (v *Quest) UnmarshalJSON(raw []byte) error {
	type plain Quest
	return decodeContent(raw, (*plain)(v), "id", "steps")
}
