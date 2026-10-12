package main

// The common keys of the TUIs: i sends a line to the greffier, @ opens the
// CABINET pane, u undoes the last write of an agent on the selected routine.
// Each runs a command of the configuration; a key without its command says so.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/aclemen1/tuikit"
	"gopkg.in/yaml.v3"
)

// tuiConfig holds the TUI's commands in the routine config.
type tuiConfig struct {
	Greffier struct {
		Text []string `yaml:"text"`
	} `yaml:"greffier"`
	Cabinet struct {
		Open []string `yaml:"open"`
	} `yaml:"cabinet"`
	Undo struct {
		Preview []string `yaml:"preview"`
		Last    []string `yaml:"last"`
	} `yaml:"undo"`
}

// configFile is the routine config: $ROUTINE_CONFIG_DIR, else
// $XDG_CONFIG_HOME/routine, else ~/.config/routine.
func configFile() string {
	dir := os.Getenv("ROUTINE_CONFIG_DIR")
	if dir == "" {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".config")
		}
		dir = filepath.Join(base, "routine")
	}
	return filepath.Join(dir, "config.yaml")
}

// loadConfig reads the TUI's commands; a missing or unreadable file leaves
// them empty, and each key then says so.
func loadConfig() tuiConfig {
	var c tuiConfig
	if b, err := os.ReadFile(configFile()); err == nil {
		_ = yaml.Unmarshal(b, &c)
	}
	return c
}

// fill replaces {ref} and {sphere} in argv and expands a leading ~; an option
// whose placeholder comes out empty is left out with its value.
func fill(argv []string, ref, sphere string) []string {
	home, _ := os.UserHomeDir()
	r := strings.NewReplacer("{ref}", ref, "{sphere}", sphere)
	var out []string
	for _, a := range argv {
		v := r.Replace(a)
		if v == "" && a != "" {
			if n := len(out); n > 0 && strings.HasPrefix(out[n-1], "-") && out[n-1] != "-" {
				out = out[:n-1]
			}
			continue
		}
		if v == "~" || strings.HasPrefix(v, "~/") {
			v = home + v[1:]
		}
		out = append(out, v)
	}
	return out
}

var actorVar = regexp.MustCompile(`^[A-Z][A-Z0-9_]*_BY=|^OFFICE_ACTOR=`)

// tuiEnv is the environment of a command the TUI runs: the actors inherited
// from the shell are dropped, and OFFICE_ACTOR signs human:AC@tui.
func tuiEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !actorVar.MatchString(kv) {
			env = append(env, kv)
		}
	}
	return append(env, "OFFICE_ACTOR="+tuiActor, "ROUTINE_BY="+tuiActor)
}

// Exec runs a command of the configuration with stdin, signed by the TUI, and
// returns what it printed on stdout; tests replace it.
var Exec = func(argv []string, stdin string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = tuiEnv()
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if err != nil {
		if msg := firstLine(errb.String()); msg != "" {
			err = fmt.Errorf("%v: %s", err, msg)
		}
	}
	return out.String(), err
}

type toolEnvelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"error"`
}

// run runs argv and reads the JSON envelope it printed.
func run(argv []string, stdin string) (toolEnvelope, error) {
	out, err := Exec(argv, stdin)
	var env toolEnvelope
	if jerr := json.Unmarshal([]byte(strings.TrimSpace(out)), &env); jerr != nil || (!env.OK && env.Error == nil) {
		if err != nil {
			return env, err
		}
		return env, fmt.Errorf("%s: unreadable answer", argv[0])
	}
	return env, nil
}

// sayMsg is a status a background job leaves for the footer.
type sayMsg struct {
	text  string
	isErr bool
}

type undoEntry struct {
	ID           string   `json:"id"`
	At           string   `json:"at"`
	Type         string   `json:"type"`
	Text         string   `json:"text"`
	By           string   `json:"by"`
	Undo         []string `json:"undo"`
	Irreversible bool     `json:"irreversible"`
}

type undoResult struct {
	Entry   undoEntry `json:"entry"`
	Command []string  `json:"command"`
}

// undoPreviewMsg is the entry undo.preview found, to confirm.
type undoPreviewMsg struct {
	id, sphere string
	res        undoResult
}

// undoneMsg: undo.last ran on the routine.
type undoneMsg struct{ id string }

type greffierAnswer struct {
	Handled bool `json:"handled"`
	Doubts  []struct {
		Question string `json:"question"`
	} `json:"doubts"`
	Proposal struct {
		Class        string `json:"class"`
		Sphere       string `json:"sphere"`
		Dossier      string `json:"dossier"`
		DossierTitle string `json:"dossier_title"`
		Status       string `json:"status"`
		Writes       []struct {
			Key string `json:"key"`
		} `json:"writes"`
	} `json:"proposal"`
}

// sphereOf is the sphere of a routine: its own, else that of its office owner.
func sphereOf(r *routine) string {
	if r.Sphere != "" {
		return r.Sphere
	}
	if m := regexp.MustCompile(`^office:([a-z]+)(/|$)`).FindStringSubmatch(r.Owner); m != nil {
		return m[1]
	}
	return ""
}

// current is the routine the gestures act on: the selected row of the list,
// else the routine open in the detail or the log.
func (m *model) current() *routine {
	if m.screen == listScreen {
		if r := m.selected(); r != nil && r.r != nil {
			return r.r
		}
		return nil
	}
	if m.detail != nil && m.detail.ID == m.detailID {
		return m.detail
	}
	for i := range m.list.Routines {
		if m.list.Routines[i].ID == m.detailID {
			return &m.list.Routines[i]
		}
	}
	return nil
}

// syncFocus writes the shared focus when the routine the TUI is on changes.
func (m *model) syncFocus() tea.Cmd {
	r := m.current()
	ref, title, sphere := "", "", ""
	if r != nil {
		ref, title, sphere = "routine:"+r.ID, r.Description, sphereOf(r)
		if title == "" {
			title = r.ID
		}
	}
	if ref == m.focusRef {
		return nil
	}
	m.focusRef = ref
	return m.focus.Set(ref, title, sphere)
}

func nonReversible(id string) string {
	return "gesture not reversible: validate it in undo tui --select " + id
}

// commonKey handles i, @ and u; false for any other key.
func (m *model) commonKey(key string) (tea.Cmd, bool) {
	switch key {
	case "i":
		return m.openGreffier(), true
	case "@":
		return m.openCabinet(), true
	case "u":
		return m.undoPreview(), true
	}
	return nil, false
}

func (m *model) openGreffier() tea.Cmd {
	if len(m.cfg.Greffier.Text) == 0 {
		m.say("greffier: no command configured (greffier.text in "+configFile()+")", true)
		return nil
	}
	ref, sphere, title := "", "", "For the greffier"
	if r := m.current(); r != nil {
		ref, sphere, title = "routine:"+r.ID, sphereOf(r), title+" · "+r.ID
	}
	m.openModal(title, tuikit.NewEditor("greffier", "Text", ""), func(v tuikit.Values) tea.Cmd {
		text := strings.TrimSpace(v.String("greffier"))
		if text == "" {
			m.say("empty text: nothing sent to the greffier", false)
			return nil
		}
		return m.sendGreffier(text, ref, sphere)
	})
	return nil
}

// sendGreffier hands the text to greffier.text on stdin, under Busy; its
// answer goes in the footer.
func (m *model) sendGreffier(text, ref, sphere string) tea.Cmd {
	argv := fill(m.cfg.Greffier.Text, ref, sphere)
	return m.busy.Wrap("greffier", func() tea.Msg {
		env, err := run(argv, text)
		if err != nil {
			return err
		}
		if !env.OK {
			return errors.New(env.Error.Message)
		}
		var a greffierAnswer
		if err := json.Unmarshal(env.Result, &a); err != nil {
			return fmt.Errorf("greffier: unreadable answer: %v", err)
		}
		return sayMsg{greffierLine(a), false}
	})
}

// greffierLine is the proposal in one line, then the doubts.
func greffierLine(a greffierAnswer) string {
	p := a.Proposal
	var parts []string
	for _, s := range []string{p.Class, p.Sphere, strings.TrimSpace(p.Dossier + " " + p.DossierTitle)} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	var keys []string
	for _, w := range p.Writes {
		if w.Key != "" {
			keys = append(keys, w.Key)
		}
	}
	if len(keys) > 0 {
		parts = append(parts, strings.Join(keys, ", "))
	}
	line := "greffier: " + strings.Join(parts, " · ")
	if p.Status != "" {
		line += " (" + p.Status + ")"
	}
	for _, d := range a.Doubts {
		if q := strings.TrimSpace(d.Question); q != "" {
			line += " · doubt: " + q
		}
	}
	return line
}

func (m *model) openCabinet() tea.Cmd {
	if len(m.cfg.Cabinet.Open) == 0 {
		m.say("CABINET: no command configured (cabinet.open in "+configFile()+")", true)
		return nil
	}
	ref, sphere := "", ""
	if r := m.current(); r != nil {
		ref, sphere = "routine:"+r.ID, sphereOf(r)
	}
	argv := fill(m.cfg.Cabinet.Open, ref, sphere)
	return m.busy.Run("CABINET", func() (string, error) {
		out, err := Exec(argv, "")
		if err != nil {
			return "", err
		}
		if l := firstLine(out); l != "" && !strings.HasPrefix(l, "{") {
			return l, nil
		}
		return "CABINET open", nil
	})
}

func (m *model) undoConfigured() bool {
	return len(m.cfg.Undo.Preview) > 0 && len(m.cfg.Undo.Last) > 0
}

// undoPreview asks undo.preview what u would undo on the routine.
func (m *model) undoPreview() tea.Cmd {
	r := m.current()
	if r == nil {
		m.say("no routine selected", false)
		return nil
	}
	if !m.undoConfigured() {
		m.say("undo: no command configured (undo.preview, undo.last in "+configFile()+")", true)
		return nil
	}
	id, sphere := r.ID, sphereOf(r)
	argv := append(fill(m.cfg.Undo.Preview, "routine:"+id, sphere), "--format", "json")
	return m.busy.Wrap("undo on "+id+": preview", func() tea.Msg {
		env, err := run(argv, "")
		if err != nil {
			return err
		}
		if !env.OK {
			switch env.Error.Kind {
			case "not_found":
				return sayMsg{"nothing to undo on " + id, false}
			case "needs_validation":
				return sayMsg{nonReversible("<id>") + " (routine:" + id + ")", true}
			}
			return errors.New(env.Error.Message)
		}
		var res undoResult
		if err := json.Unmarshal(env.Result, &res); err != nil {
			return fmt.Errorf("undo: unreadable answer: %v", err)
		}
		if res.Entry.Irreversible {
			return sayMsg{nonReversible(res.Entry.ID), true}
		}
		return undoPreviewMsg{id, sphere, res}
	})
}

// confirmUndo shows the entry and its reverse before undo.last runs.
func (m *model) confirmUndo(msg undoPreviewMsg) {
	e := msg.res.Entry
	inv := e.Undo
	if len(inv) == 0 {
		inv = msg.res.Command
	}
	q := "Undo the last write on " + msg.id + "?\n\n" + clock(e.At) + "  " + e.Type + "  " + firstLine(e.Text)
	if e.By != "" {
		q += "  (" + e.By + ")"
	}
	q += "\n\nReverse: " + strings.Join(inv, " ")
	m.openModal("Undo", tuikit.NewConfirm("undo", q), func(tuikit.Values) tea.Cmd {
		return m.runUndo(msg.id, msg.sphere, e.ID)
	})
}

// runUndo runs undo.last on the routine, under Busy; a needs_validation is
// never run from the TUI.
func (m *model) runUndo(id, sphere, entry string) tea.Cmd {
	argv := append(fill(m.cfg.Undo.Last, "routine:"+id, sphere), "--format", "json")
	job := m.busy.Wrap("undo on "+id, func() tea.Msg {
		env, err := run(argv, "")
		if err != nil {
			return err
		}
		if !env.OK {
			if env.Error.Kind == "needs_validation" {
				return sayMsg{nonReversible(entry), true}
			}
			return errors.New(env.Error.Message)
		}
		return undoneMsg{id}
	})
	return tea.Sequence(job, m.refresh())
}
