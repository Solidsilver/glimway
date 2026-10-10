// The wardrobe's two pure steps (docs/design/purse-and-wardrobe.md 4.2):
// Resolve, which drops a chosen key the player no longer owns or the catalog
// no longer knows (server only), and Look, which turns the resolved choice
// and a Habitica profile into what the hero wears here. Both replay the
// shared vectors in content/vectors/wardrobe.json (resolve and lookFor).
package rules

// DrawnSlots are Habitica's drawn gear types, the wardrobe's slots.
// weaponSpecial (in Slots) is never drawn and is not offered.
var DrawnSlots = []string{"head", "headAccessory", "eyewear", "armor", "body", "back", "weapon", "shield"}

// NoGear is the reserved choice "Nothing" for a slot. Habitica's keys are
// `type_klass_index`, so none can never collide with one.
const NoGear = "none"

// IsDrawnSlot: a slot the wardrobe offers.
func IsDrawnSlot(slot string) bool {
	for _, s := range DrawnSlots {
		if s == slot {
			return true
		}
	}
	return false
}

// Resolve is the server-only step that runs when someone looks: a chosen key
// the player no longer owns (a lapsed piece) or the catalog no longer knows
// drops out of the resolved choice, and the rest keeps its slots. The stored
// rows are not rewritten — only the resolution shrinks — so a piece that
// comes back (a warrior re-buys gear lost to death) comes back to its place.
// The reserved "none" is kept as it is. `known` is the catalog's membership
// test (the key set of content's habitica-gear snapshot).
func Resolve(chosen map[string]string, owned []string, known func(string) bool) map[string]string {
	has := map[string]bool{}
	for _, key := range owned {
		has[key] = true
	}
	out := map[string]string{}
	for slot, key := range chosen {
		if key == NoGear {
			out[slot] = key
			continue
		}
		if key != "" && has[key] && known(key) {
			out[slot] = key
		}
	}
	return out
}

// Look is what the hero wears here (lookFor in the shared vectors): per drawn
// slot, the chosen key, nothing ("none"), or — with nothing chosen for the
// slot — Habitica's own look, its costume when useCostume is on and its
// battle gear when it isn't. A missing profile key resolves to null (nothing
// worn there); a `*_base_0` none-piece is returned as a key and draws nothing
// downstream. weaponSpecial is never drawn and never appears. The avatar's
// own rules apply after this, unchanged (a two-handed weapon hides the
// shield).
func Look(p Profile, chosen map[string]string) map[string]*string {
	out := map[string]string{}
	for _, slot := range DrawnSlots {
		switch key := chosen[slot]; {
		case key == NoGear:
			out[slot] = ""
		case key != "":
			out[slot] = key
		default:
			worn := p.Equipped
			if p.UseCostume {
				worn = p.Costume
			}
			if v := worn[slot]; v != nil && *v != "" {
				out[slot] = *v
			}
		}
	}
	look := map[string]*string{}
	for _, slot := range DrawnSlots {
		if key := out[slot]; key != "" {
			look[slot] = &key
		} else {
			look[slot] = nil
		}
	}
	return look
}
