package api

// One UTC day helper for every daily cap the server counts. Time is worked
// out, not ticked (docs/design/crafts.md rule 3): a cap is "how many rows
// fall in the UTC day this moment is in", never a timer that resets.
//
// It replaces the three private spellings of the same idea (market.go's
// dayStart for the sellers' caps, item_use.go's todayStart for the maker's
// thank-you mail, item_wardens.go's utcDay for the heal day), and 0.6's
// top-up limit counts its two a day with it (docs/design/purse-and-wardrobe.md
// 2.5).

// utcDay is the UTC day a moment falls in, in days since the Unix epoch.
func utcDay(now int64) int64 { return now / 86400 }

// utcDayStart is that day's UTC midnight, in Unix seconds: where a daily
// count's rows start.
func utcDayStart(now int64) int64 { return utcDay(now) * 86400 }
