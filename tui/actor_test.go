package main

import (
	"strings"
	"testing"
)

// A gesture of the TUI is signed human:AC@tui, even with an actor inherited from the shell.
func TestCommandSignsTUI(t *testing.T) {
	t.Setenv("ROUTINE_BY", "agent:greffier")
	t.Setenv("OFFICE_ACTOR", "agent:office-P-0019")
	cmd := command("pause", "x")
	// exec keeps the last value of a duplicated key: it must be the TUI's.
	last := ""
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, "ROUTINE_BY=") {
			last = kv
		}
	}
	if last != "ROUTINE_BY=human:AC@tui" {
		t.Fatalf("last ROUTINE_BY is %q, want ROUTINE_BY=human:AC@tui", last)
	}
}
