package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/aclemen1/tuikit"
	"github.com/charmbracelet/x/ansi"
)

type ran struct {
	argv  []string
	stdin string
}

// stub replaces Exec: each call is recorded and answered by reply.
func stub(t *testing.T, reply func(argv []string) string) *[]ran {
	t.Helper()
	var calls []ran
	old := Exec
	Exec = func(argv []string, stdin string) (string, error) {
		calls = append(calls, ran{argv, stdin})
		return reply(argv), nil
	}
	t.Cleanup(func() { Exec = old })
	return &calls
}

// pump runs a command and the commands its messages give back, leaving out
// the spinner of Busy.
func pump(m *model, cmd tea.Cmd, depth int) {
	if cmd == nil || depth > 8 {
		return
	}
	msg := cmd()
	if msg == nil || strings.HasSuffix(fmt.Sprintf("%T", msg), "busyTickMsg") {
		return
	}
	if v := reflect.ValueOf(msg); v.Kind() == reflect.Slice && v.Type().Elem() == reflect.TypeOf(tea.Cmd(nil)) {
		for i := 0; i < v.Len(); i++ {
			pump(m, v.Index(i).Interface().(tea.Cmd), depth+1)
		}
		return
	}
	_, next := m.Update(msg)
	pump(m, next, depth+1)
}

func press(m *model, k tea.KeyPressMsg) {
	_, cmd := m.Update(k)
	pump(m, cmd, 0)
}

func key(s string) tea.KeyPressMsg {
	r := []rune(s)[0]
	return tea.KeyPressMsg{Code: r, Text: s}
}

func setup(t *testing.T) *model {
	t.Helper()
	t.Setenv("HOME", t.TempDir()) // keys save the view state
	t.Setenv("OFFICE_FOCUS", filepath.Join(t.TempDir(), "focus.json"))
	t.Setenv("ROUTINE_CLI", `["false"]`) // a reload after a gesture reads nothing real
	old := tuikit.FocusDelay
	tuikit.FocusDelay = time.Millisecond
	t.Cleanup(func() { tuikit.FocusDelay = old })
	tuikit.SetLanguage(tuikit.English)
	m := &model{follow: true, busy: tuikit.NewBusy(), focus: tuikit.NewFocus("routine"), loaded: true, sortBy: "id"}
	m.list.Routines = []routine{
		{ID: "brief", Description: "Morning brief", Sphere: "perso", Active: true, Rrules: []string{"FREQ=DAILY"}},
		{ID: "sync", Description: "Sync the vault", Owner: "office:pro/U-0003", Active: false, Rrules: []string{"FREQ=HOURLY"}},
	}
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	return m
}

func configure(m *model) {
	m.cfg.Greffier.Text = []string{"greffier", "text", "-", "--focus", "{ref}", "--sphere", "{sphere}"}
	m.cfg.Undo.Preview = []string{"undo", "last", "--ref", "{ref}", "--dry-run"}
	m.cfg.Undo.Last = []string{"undo", "last", "--ref", "{ref}"}
}

func TestFocusWrittenOnSelection(t *testing.T) {
	m := setup(t)
	press(m, key("j"))
	b, err := os.ReadFile(os.Getenv("OFFICE_FOCUS"))
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]string
	json.Unmarshal(b, &f)
	if f["ref"] != "routine:sync" || f["tool"] != "routine" || f["sphere"] != "pro" || f["title"] != "Sync the vault" || f["at"] == "" {
		t.Errorf("focus: %v", f)
	}
}

func TestConfigReadsTheCommands(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ROUTINE_CONFIG_DIR", dir)
	os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(`journal: [logbook]
greffier: {text: [greffier, text, "-", --focus, "{ref}", --sphere, "{sphere}"]}
cabinet: {open: []}
undo:
  preview: [undo, last, --ref, "{ref}", --dry-run]
  last: [undo, last, --ref, "{ref}"]
`), 0o644)
	c := loadConfig()
	if strings.Join(c.Greffier.Text, " ") != "greffier text - --focus {ref} --sphere {sphere}" || len(c.Cabinet.Open) != 0 || len(c.Undo.Last) != 4 {
		t.Errorf("config: %+v", c)
	}
	if got := strings.Join(fill(c.Greffier.Text, "", ""), " "); got != "greffier text -" {
		t.Errorf("empty placeholders: %q", got)
	}
}

func TestGreffierGetsTextOnStdin(t *testing.T) {
	m := setup(t)
	press(m, key("i"))
	if !strings.Contains(m.msg, "no command configured") || m.modal.Open() {
		t.Fatalf("i without command: %q", m.msg)
	}
	configure(m)
	calls := stub(t, func([]string) string {
		return `{"ok":true,"result":{"handled":false,"doubts":[{"question":"Which dossier?"}],"proposal":{"class":"action","sphere":"perso","dossier":"P-0024","writes":[{"key":"task"}],"status":"observed"}}}`
	})
	press(m, key("i"))
	if !m.modal.Open() {
		t.Fatal("i opens no input")
	}
	for _, r := range "move it to 8" {
		press(m, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	press(m, tea.KeyPressMsg{Code: 's', Mod: tea.ModCtrl})
	if len(*calls) != 1 {
		t.Fatalf("calls: %+v", *calls)
	}
	c := (*calls)[0]
	if strings.Join(c.argv, " ") != "greffier text - --focus routine:brief --sphere perso" || c.stdin != "move it to 8" {
		t.Errorf("call: %+v", c)
	}
	if m.msg != "greffier: action · perso · P-0024 · task (observed) · doubt: Which dossier?" {
		t.Errorf("status: %q", m.msg)
	}
}

func TestCommandsAreSignedByTheTUI(t *testing.T) {
	t.Setenv("GREFFIER_BY", "agent:shell")
	t.Setenv("OFFICE_ACTOR", "agent:office-P-0019")
	env := strings.Join(tuiEnv(), "\n")
	if strings.Contains(env, "agent:") || !strings.Contains(env, "OFFICE_ACTOR="+tuiActor) {
		t.Errorf("env: %s", env)
	}
}

func TestCabinetEmpty(t *testing.T) {
	m := setup(t)
	calls := stub(t, func([]string) string { return "" })
	press(m, key("@"))
	if !strings.HasPrefix(m.msg, "CABINET: no command configured") || len(*calls) != 0 {
		t.Errorf("@ empty: %q %v", m.msg, *calls)
	}
}

func TestUndoConfirmsThenRuns(t *testing.T) {
	m := setup(t)
	press(m, key("u"))
	if !strings.Contains(m.msg, "no command configured") {
		t.Fatalf("u without command: %q", m.msg)
	}
	configure(m)
	entry := `{"id":"routine:brief@2026-10-12T10:00:00+02:00","at":"2026-10-12T10:00:00+02:00","type":"pause","text":"paused","by":"agent:greffier","undo":["routine","resume","brief"]}`
	calls := stub(t, func(argv []string) string {
		return `{"ok":true,"result":{"entry":` + entry + `,"command":["routine","resume","brief"]}}`
	})
	press(m, key("u"))
	if len(*calls) != 1 || strings.Join((*calls)[0].argv, " ") != "undo last --ref routine:brief --dry-run --format json" {
		t.Fatalf("preview: %+v", *calls)
	}
	if !m.modal.Open() {
		t.Fatal("no confirmation")
	}
	view := ansi.Strip(m.render())
	for _, want := range []string{"pause  paused  (agent:greffier)", "Reverse: routine resume brief"} {
		if !strings.Contains(view, want) {
			t.Errorf("confirmation lacks %q:\n%s", want, view)
		}
	}
	press(m, key("y"))
	press(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	if len(*calls) < 2 || strings.Join((*calls)[1].argv, " ") != "undo last --ref routine:brief --format json" {
		t.Fatalf("last: %+v", *calls)
	}
}

func TestUndoRefusesNeedsValidation(t *testing.T) {
	m := setup(t)
	configure(m)
	// Marked irreversible in the preview: no confirmation, nothing run.
	calls := stub(t, func([]string) string {
		return `{"ok":true,"result":{"entry":{"id":"routine:brief@T","undo":["routine","rm","brief"],"irreversible":true},"command":["routine","rm","brief"]}}`
	})
	press(m, key("u"))
	if m.modal.Open() || len(*calls) != 1 || m.msg != "gesture not reversible: validate it in undo tui --select routine:brief@T" {
		t.Fatalf("irreversible: %q %v", m.msg, *calls)
	}
	// Refused by undo.last after the confirmation: the message, nothing more.
	n := 0
	calls = stub(t, func(argv []string) string {
		n++
		if n == 1 {
			return `{"ok":true,"result":{"entry":{"id":"routine:brief@T","undo":["routine","resume","brief"]},"command":[]}}`
		}
		return `{"ok":false,"error":{"code":6,"kind":"needs_validation","message":"Alain must validate"}}`
	})
	press(m, key("u"))
	press(m, key("y"))
	press(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	if len(*calls) != 2 || m.msg != "gesture not reversible: validate it in undo tui --select routine:brief@T" || !m.msgErr {
		t.Fatalf("needs_validation: %q %v", m.msg, *calls)
	}
}

func TestJournalMarksUndoable(t *testing.T) {
	m := setup(t)
	r := m.list.Routines[0]
	r.Journal = []journalEntry{
		{At: "2026-10-12T10:00:00+02:00", Type: "pause", Text: "paused", By: "agent:greffier", Undo: []string{"routine", "resume", "brief"}},
		{At: "2026-10-12T09:00:00+02:00", Type: "run", Text: "ok · 2s"},
	}
	m.screen, m.detailID, m.detail = detailScreen, r.ID, &r
	if strings.Contains(ansi.Strip(m.render()), "↶") {
		t.Error("mark without undo.last")
	}
	configure(m)
	if out := ansi.Strip(m.render()); strings.Count(out, "↶ undoable") != 1 || !strings.Contains(out, "paused  ↶ undoable") {
		t.Errorf("journal:\n%s", out)
	}
}

// space toggles pause and resume; u no longer resumes.
func TestSpaceResumesAndUUndoes(t *testing.T) {
	m := setup(t)
	press(m, key("j")) // sync, paused
	calls := stub(t, func([]string) string { return "" })
	if cmd := m.routineKey(" ", "sync", "", &m.list.Routines[1]); cmd == nil {
		t.Fatal("space on a paused routine resumes nothing")
	}
	if cmd := m.routineKey("u", "sync", "", &m.list.Routines[1]); cmd != nil {
		t.Fatal("u still resumes")
	}
	press(m, key("u"))
	if !strings.Contains(m.msg, "undo: no command configured") || len(*calls) != 0 {
		t.Errorf("u: %q", m.msg)
	}
	if strings.Contains(strings.Join(legend(), "\n"), "u  resume") {
		t.Error("legend still has u resume")
	}
}
