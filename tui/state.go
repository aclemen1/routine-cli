package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The TUI's preferences live in the user's config directory, like the office TUI's,
// so that a new start finds the same sort, filter and selection.

type savedState struct {
	Sort     string `json:"sort,omitempty"`
	SortDesc bool   `json:"sort_desc,omitempty"`
	Filter   string `json:"filter,omitempty"`
	Legend   bool   `json:"legend,omitempty"`
	Selected string `json:"selected,omitempty"`
}

func statePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "routine", "tui.json")
}

func loadState() savedState {
	var s savedState
	if b, err := os.ReadFile(statePath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if sortIndex(s.Sort) < 0 {
		s.Sort = sorts[0]
	}
	return s
}

func (m *model) state() savedState {
	return savedState{Sort: m.sortBy, SortDesc: m.sortDesc, Filter: m.filter, Legend: m.legend, Selected: m.selID}
}

// save writes the preferences when they changed.
func (m *model) save() {
	s := m.state()
	if s == m.saved {
		return
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	p := statePath()
	if os.MkdirAll(filepath.Dir(p), 0o755) != nil {
		return
	}
	if os.WriteFile(p+".tmp", b, 0o644) == nil && os.Rename(p+".tmp", p) == nil {
		m.saved = s
	}
}

func (m *model) restore(s savedState) {
	m.sortBy, m.sortDesc, m.filter, m.legend, m.selID = s.Sort, s.SortDesc, s.Filter, s.Legend, s.Selected
	m.saved = s
}

// sorts is the order `s` cycles through.
var sorts = []string{"id", "next", "last", "state", "owner"}

var sortLabels = map[string]string{"id": "ID", "next": "NEXT", "last": "LAST RUN", "state": "STATE", "owner": "OWNER"}

func sortIndex(name string) int {
	for i, s := range sorts {
		if s == name {
			return i
		}
	}
	return -1
}

func stateRank(r *routine) int {
	switch {
	case r.Running:
		return 0
	case r.Active:
		return 1
	default:
		return 2
	}
}

// sortRoutines orders by the chosen key, then by id. Missing values (no next run,
// never run, no owner) go last whatever the direction.
func sortRoutines(rows []row, by string, desc bool) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i].r, rows[j].r
		cmp := 0
		missingA, missingB := false, false
		switch by {
		case "next":
			missingA, missingB = a.Next == nil || !a.Active, b.Next == nil || !b.Active
			if !missingA && !missingB {
				cmp = strings.Compare(*a.Next, *b.Next)
			}
		case "last":
			missingA, missingB = a.LastRun == nil, b.LastRun == nil
			if !missingA && !missingB {
				cmp = strings.Compare(a.LastRun.Started, b.LastRun.Started)
			}
		case "state":
			cmp = stateRank(a) - stateRank(b)
		case "owner":
			missingA, missingB = a.Owner == "", b.Owner == ""
			if !missingA && !missingB {
				cmp = strings.Compare(a.Owner, b.Owner)
			}
		}
		if missingA != missingB {
			return missingB
		}
		if desc {
			cmp = -cmp
		}
		if cmp == 0 {
			cmp = strings.Compare(a.ID, b.ID)
			if desc && by == "id" {
				cmp = -cmp
			}
		}
		return cmp < 0
	})
}
