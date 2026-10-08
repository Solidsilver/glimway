package content

// PaperRule matches the story port and the generated find catalog.
type PaperRule struct {
	Kind    string `json:"kind"`
	Area    string `json:"area,omitempty"`
	TX      int    `json:"tx,omitempty"`
	TY      int    `json:"ty,omitempty"`
	After   string `json:"after,omitempty"`
	Stage   string `json:"stage,omitempty"`
	From    string `json:"from,omitempty"`
	Project string `json:"project,omitempty"`
	Fact    string `json:"fact,omitempty"`
	POI     string `json:"poi,omitempty"`
	Site    string `json:"site,omitempty"`
	Member  string `json:"member,omitempty"`
	Paper   string `json:"paper,omitempty"`
	RoadLit bool   `json:"roadLit,omitempty"`
	East    bool   `json:"east,omitempty"`
	Mark    string `json:"mark,omitempty"`
	Tier    int    `json:"tier,omitempty"`
	Unbuilt bool   `json:"unbuilt,omitempty"`
}
