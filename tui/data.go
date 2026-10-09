package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Everything is read and changed through `routine … --json`: the engine stays the only source of truth.

type acpSpec struct {
	Command     string         `json:"command"`
	Args        []string       `json:"args"`
	Meta        map[string]any `json:"meta,omitempty"`
	Close       string         `json:"close"`
	Permissions string         `json:"permissions"`
}

type step struct {
	Name            string   `json:"name"`
	Run             string   `json:"run,omitempty"`
	Acp             *acpSpec `json:"acp,omitempty"`
	TimeoutMs       int64    `json:"timeoutMs,omitempty"`
	Cwd             string   `json:"cwd,omitempty"`
	ContinueOnError bool     `json:"continueOnError"`
}

type stepRecord struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Error      string `json:"error,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
}

type runRecord struct {
	ID         string       `json:"id"`
	Started    string       `json:"started"`
	Ended      string       `json:"ended"`
	Status     string       `json:"status"`
	ExitCode   *int         `json:"exitCode"`
	Log        string       `json:"log"`
	Scheduled  string       `json:"scheduled,omitempty"`
	Manual     bool         `json:"manual,omitempty"`
	Error      string       `json:"error,omitempty"`
	SessionID  string       `json:"sessionId,omitempty"`
	StopReason string       `json:"stopReason,omitempty"`
	Steps      []stepRecord `json:"steps,omitempty"`
}

type routine struct {
	ID            string         `json:"id"`
	File          string         `json:"file"`
	Owner         string         `json:"owner,omitempty"`
	Description   string         `json:"description,omitempty"`
	Active        bool           `json:"active"`
	Running       bool           `json:"running"`
	RunningSince  string         `json:"runningSince,omitempty"`
	Rrules        []string       `json:"rrules"`
	Recurrence    string         `json:"recurrence"`
	Dtstart       string         `json:"dtstart,omitempty"`
	Tz            string         `json:"tz"`
	Timeout       string         `json:"timeout"`
	Cwd           string         `json:"cwd,omitempty"`
	Run           string         `json:"run,omitempty"`
	Acp           *acpSpec       `json:"acp,omitempty"`
	Steps         []step         `json:"steps,omitempty"`
	Meta          map[string]any `json:"meta,omitempty"`
	Next          *string        `json:"next"`
	LastScheduled string         `json:"lastScheduled,omitempty"`
	LastRun       *runRecord     `json:"lastRun,omitempty"`
	// Set by show only.
	Upcoming []string `json:"upcoming,omitempty"`
	Body     string   `json:"body,omitempty"`
}

type invalid struct {
	ID    string `json:"id"`
	File  string `json:"file"`
	Error string `json:"error"`
}

type list struct {
	Routines []routine `json:"routines"`
	Errors   []invalid `json:"errors"`
}

type engineStatus struct {
	Stopped  bool     `json:"stopped"`
	Routines int      `json:"routines"`
	Active   int      `json:"active"`
	Running  []string `json:"running"`
	Due      []string `json:"due"`
	Invalid  int      `json:"invalid"`
}

// cli is the routine command: ROUTINE_CLI holds it as a JSON array (set by `routine tui`), else `routine` in PATH.
func cli() []string {
	if raw := os.Getenv("ROUTINE_CLI"); raw != "" {
		var argv []string
		if json.Unmarshal([]byte(raw), &argv) == nil && len(argv) > 0 {
			return argv
		}
	}
	return []string{"routine"}
}

func command(args ...string) *exec.Cmd {
	argv := append(cli(), args...)
	return exec.Command(argv[0], argv[1:]...)
}

// envelope is what routine prints: {ok, result} or {ok: false, error}.
type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// call runs a routine action and decodes its result. A failed command reports
// its error message; a command whose object failed (check, run) still decodes.
func call(out any, args ...string) error {
	cmd := command(append(args, "--format", "json")...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()
	var env envelope
	if err := json.Unmarshal(stdout.Bytes(), &env); err != nil {
		if msg := strings.TrimSpace(firstLine(stderr.String())); msg != "" {
			return errors.New(msg)
		}
		if runErr != nil {
			return runErr
		}
		return err
	}
	if !env.OK {
		if env.Error != nil {
			return errors.New(env.Error.Message)
		}
		return errors.New("routine " + strings.Join(args, " ") + " failed")
	}
	if out == nil || len(env.Result) == 0 {
		return nil
	}
	return json.Unmarshal(env.Result, out)
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

func loadList() (list, engineStatus, error) {
	var l list
	var s engineStatus
	if err := call(&l, "ls"); err != nil {
		return l, s, err
	}
	err := call(&s, "status")
	return l, s, err
}

func loadDetail(id string) (routine, []runRecord, error) {
	var r routine
	var runs []runRecord
	if err := call(&r, "show", id, "-n", "5"); err != nil {
		return r, nil, err
	}
	err := call(&runs, "log", id, "-n", "15")
	return r, runs, err
}

// startRun launches `routine run` detached: it outlives the TUI, and the lock shows it running.
func startRun(id string) error {
	cmd := command("run", id)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// sessionTab finds the herdr tab of an ACP session from herdr-acp's pane records.
func sessionTab(sessionID string) (string, error) {
	home, _ := os.UserHomeDir()
	b, err := os.ReadFile(filepath.Join(home, ".local", "state", "herdr-acp", "panes", sessionID+".json"))
	if err != nil {
		return "", fmt.Errorf("no herdr-acp pane recorded for session %s", short(sessionID))
	}
	var rec struct {
		TabID string `json:"tabId"`
	}
	if err := json.Unmarshal(b, &rec); err != nil || rec.TabID == "" {
		return "", fmt.Errorf("unreadable herdr-acp record for session %s", short(sessionID))
	}
	return rec.TabID, nil
}

func focusTab(tabID string) error {
	out, err := exec.Command("herdr", "tab", "focus", tabID).CombinedOutput()
	if err != nil {
		if msg := firstLine(string(out)); msg != "" {
			return errors.New(msg)
		}
	}
	return err
}

// lastSession is the latest ACP session of a run: its own, or that of its last acp step.
func lastSession(r *runRecord) string {
	if r == nil {
		return ""
	}
	if r.SessionID != "" {
		return r.SessionID
	}
	for i := len(r.Steps) - 1; i >= 0; i-- {
		if r.Steps[i].SessionID != "" {
			return r.Steps[i].SessionID
		}
	}
	return ""
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func parseTime(iso string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, iso)
	return t.Local(), err == nil
}
