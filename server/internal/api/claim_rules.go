package api

// Who may build on a Built claim's land (lamps.md 2.5; migration 045). A
// claim is its hold's holder, kind and id; its keeper sets one rule and one
// list of world members:
//
//	household (the default) the keeper's household
//	listed                  the household and the members named
//	except                  every world member but those named
//	everyone                every world member
//
// The keeper always may. Building is setting pieces out, planting, naming
// the lamp, felling, breaking or digging, clearing, and laying or lifting
// paths. Walking there, foraging, adding oil, reading the naming and taking
// back your own pieces are never refused by a rule.
// Camps use it now (camps.go); lot backland and Wilds hearths may later.

import (
	"context"
	"database/sql"
	"errors"
	"slices"
)

// The claim rules.
const (
	ruleHousehold = "household"
	ruleListed    = "listed"
	ruleExcept    = "except"
	ruleEveryone  = "everyone"
)

// claimRuleMembers caps a rule's list: a world's worth of friends.
const claimRuleMembers = 64

// claimKey is a Built claim: its world and its holder's kind and id.
type claimKey struct{ World, Kind, ID string }

// claimRule is a claim's rule and the members it names, in account order.
type claimRule struct {
	Rule   string
	Listed []string
}

// readClaimRule is a claim's rule: household, naming no one, when unset.
func readClaimRule(ctx context.Context, tx *sql.Tx, k claimKey) (claimRule, error) {
	r := claimRule{Rule: ruleHousehold, Listed: []string{}}
	err := tx.QueryRowContext(ctx, "SELECT rule FROM claim_rules WHERE world_id=? AND holder_kind=? AND holder_id=?", k.World, k.Kind, k.ID).Scan(&r.Rule)
	if errors.Is(err, sql.ErrNoRows) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT account_id FROM claim_rule_members WHERE world_id=? AND holder_kind=? AND holder_id=? ORDER BY account_id", k.World, k.Kind, k.ID)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return r, err
		}
		r.Listed = append(r.Listed, id)
	}
	return r, rows.Err()
}

// mayBuild: the account may build on the claim's land, its keeper's.
// Every build check of a claim goes through here.
func mayBuild(ctx context.Context, tx *sql.Tx, k claimKey, keeper, account string) (bool, error) {
	if account == keeper {
		return true, nil
	}
	if ok, err := worldMember(ctx, tx, k.World, account); err != nil || !ok {
		return false, err
	}
	r, err := readClaimRule(ctx, tx, k)
	if err != nil {
		return false, err
	}
	listed := slices.Contains(r.Listed, account)
	switch r.Rule {
	case ruleEveryone:
		return true, nil
	case ruleExcept:
		return !listed, nil
	case ruleListed:
		if listed {
			return true, nil
		}
	}
	return sameHousehold(ctx, tx, account, keeper)
}

// setClaimRule replaces a claim's rule and list. Everyone named must live
// in the claim's world (not-in-world); the keeper needs no naming. The list
// is kept whatever the rule, so switching rules loses no names; only listed
// and except read it.
func setClaimRule(ctx context.Context, tx *sql.Tx, k claimKey, keeper, rule string, members []string, now int64) error {
	if !slices.Contains([]string{ruleHousehold, ruleListed, ruleExcept, ruleEveryone}, rule) {
		return fail(400, "invalid-request")
	}
	listed := []string{}
	for _, m := range members {
		if m != keeper && !slices.Contains(listed, m) {
			listed = append(listed, m)
		}
	}
	if len(listed) > claimRuleMembers {
		return fail(400, "invalid-request")
	}
	for _, m := range listed {
		if ok, err := worldMember(ctx, tx, k.World, m); err != nil {
			return err
		} else if !ok {
			return fail(409, "not-in-world")
		}
	}
	if err := dropClaimRule(ctx, tx, k); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO claim_rules(world_id,holder_kind,holder_id,rule,set_at) VALUES(?,?,?,?,?)", k.World, k.Kind, k.ID, rule, now); err != nil {
		return err
	}
	for _, m := range listed {
		if _, err := tx.ExecContext(ctx, "INSERT INTO claim_rule_members(world_id,holder_kind,holder_id,account_id) VALUES(?,?,?,?)", k.World, k.Kind, k.ID, m); err != nil {
			return err
		}
	}
	return nil
}

// dropClaimRule forgets a claim's rule: it has ended (taken down, lapsed),
// and a claim set again there starts at household.
func dropClaimRule(ctx context.Context, tx *sql.Tx, k claimKey) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM claim_rule_members WHERE world_id=? AND holder_kind=? AND holder_id=?", k.World, k.Kind, k.ID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM claim_rules WHERE world_id=? AND holder_kind=? AND holder_id=?", k.World, k.Kind, k.ID)
	return err
}

// worldMember: the account lives in the world.
func worldMember(ctx context.Context, tx *sql.Tx, world, account string) (bool, error) {
	var ok bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM players WHERE account_id=? AND world_id=?)", account, world).Scan(&ok)
	return ok, err
}

// sameHousehold: the two accounts share a homestead.
func sameHousehold(ctx context.Context, tx *sql.Tx, a, b string) (bool, error) {
	var ok bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_members x JOIN homestead_members y ON x.homestead_id=y.homestead_id WHERE x.account_id=? AND y.account_id=?)", a, b).Scan(&ok)
	return ok, err
}
