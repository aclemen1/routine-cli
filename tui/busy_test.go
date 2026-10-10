package main

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/aclemen1/tuikit"
	"github.com/charmbracelet/x/ansi"
)

// runCmd runs a command and feeds its messages back to the model.
func runCmd(m *model, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		for _, c := range msg {
			runCmd(m, c)
		}
	default:
		m.Update(msg)
	}
}

func TestBusyShowsJobsAndFailures(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // keys save the view state
	tuikit.SetLanguage(tuikit.English)
	m := &model{follow: true, busy: tuikit.NewBusy(), loaded: true}
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	release := make(chan struct{})
	job := m.busy.Run("pause brief", func() (string, error) { <-release; return "brief: paused", nil })
	if out := ansi.Strip(m.render()); !strings.Contains(out, "pause brief") {
		t.Fatalf("running job missing:\n%s", out)
	}
	close(release)
	runCmd(m, job)
	runCmd(m, m.busy.Run("resume brief", func() (string, error) { return "", errors.New("no routine brief") }))
	out := ansi.Strip(m.render())
	if !strings.Contains(out, "✗ resume brief : no routine brief") || !strings.Contains(out, "! failed job") {
		t.Fatalf("failure not shown:\n%s", out)
	}
	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})
	if !strings.Contains(ansi.Strip(m.render()), "no routine brief") {
		t.Fatal("a failure must stay until the list is opened")
	}
	m.Update(tea.KeyPressMsg{Code: '!', Text: "!"})
	if !m.modal.Open() || !strings.Contains(ansi.Strip(m.render()), "Jobs") {
		t.Fatal("! must open the list of jobs")
	}
	if m.busy.Unread() != 0 {
		t.Fatal("opening the list marks failures read")
	}
	_, esc := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	runCmd(m, esc)
	if m.modal.Open() {
		t.Fatal("esc must close the list")
	}
	m.Update(tea.KeyPressMsg{Code: '/', Text: "/"})
	m.Update(tea.KeyPressMsg{Code: '!', Text: "!"})
	if m.modal.Open() || m.filter != "!" {
		t.Fatalf("! typed in the filter must not open the list (filter %q)", m.filter)
	}
}
