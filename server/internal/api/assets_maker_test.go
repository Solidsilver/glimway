package api

import (
	"strings"
	"testing"

	"glimway/content"
)

// A decoration or instance asset never carries a maker: the piece's maker
// is the player who crafted it, not part of the request. An explicit
// "maker" — even the empty string — is refused, so takeStack/packTake never
// read a present-but-empty maker as "unmarked stacks only".
func TestValidAssetRefusesAMakerOnAPiece(t *testing.T) {
	decoration := func(maker *string) *content.Asset {
		return &content.Asset{Kind: "decoration", Id: "wooden-stool", Qty: 1, Maker: maker}
	}
	if err := validAsset(decoration(nil)); err != nil {
		t.Fatalf("a decoration without a maker is fine: %v", err)
	}
	empty := ""
	if err := validAsset(decoration(&empty)); err == nil || !strings.Contains(err.Error(), "invalid-asset") {
		t.Fatalf(`an explicit "maker": "" must be refused: %v`, err)
	}
	named := "wren"
	if err := validAsset(decoration(&named)); err == nil || !strings.Contains(err.Error(), "invalid-asset") {
		t.Fatalf("a named maker on a decoration must be refused: %v", err)
	}
}
