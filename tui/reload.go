package main

import (
	"encoding/json"
	"os"
	"os/signal"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"
)

// The TUI reloads itself when its binary is rebuilt: at rest at once, otherwise as soon as it is at rest again.

// version is set at build time: go build -ldflags "-X main.version=<commit>".
var version = "dev"

type binaryID struct {
	modTime time.Time
	inode   uint64
}

func statBinary(path string) (binaryID, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return binaryID{}, false
	}
	id := binaryID{modTime: fi.ModTime()}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		id.inode = st.Ino
	}
	return id, true
}

type binaryCheckMsg struct{}

type forceReloadMsg struct{}

func checkBinary() tea.Cmd {
	return tea.Tick(3*time.Second, func(time.Time) tea.Msg { return binaryCheckMsg{} })
}

// resumeState is what a reload hands to the new binary, besides the saved preferences.
type resumeState struct {
	Screen   screenKind `json:"screen"`
	Detail   string     `json:"detail,omitempty"`
	LogPath  string     `json:"log_path,omitempty"`
	LogTitle string     `json:"log_title,omitempty"`
	LogFrom  screenKind `json:"log_from"`
}

const resumeEnv = "ROUTINE_TUI_RESUME"

// idle: no input, no confirmation, no editor open.
func (m *model) idle() bool {
	return m.ask == nil && !m.typing && !m.editing
}

func (m *model) checkReload() tea.Cmd {
	if !m.newVersion || !m.idle() {
		return nil
	}
	m.reloading = true
	return tea.Quit
}

func (m *model) onBinaryCheck() tea.Cmd {
	if id, ok := statBinary(m.binPath); ok && m.binID != (binaryID{}) && id != m.binID {
		m.newVersion = true
	}
	return tea.Batch(m.checkReload(), checkBinary())
}

// listenUSR1 turns SIGUSR1 into a reload request.
func listenUSR1(p *tea.Program) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGUSR1)
	go func() {
		for range ch {
			p.Send(forceReloadMsg{})
		}
	}()
}

// execReload replaces the process with the new binary, handing over the view.
func (m *model) execReload() error {
	m.save()
	b, _ := json.Marshal(resumeState{Screen: m.screen, Detail: m.detailID, LogPath: m.logPath, LogTitle: m.logTitle, LogFrom: m.logFrom})
	env := append(os.Environ(), resumeEnv+"="+string(b))
	return syscall.Exec(m.binPath, os.Args, env)
}

// resume applies what a reload handed over and says so.
func (m *model) resume() tea.Cmd {
	raw := os.Getenv(resumeEnv)
	if raw == "" {
		return nil
	}
	os.Unsetenv(resumeEnv)
	var r resumeState
	if json.Unmarshal([]byte(raw), &r) != nil {
		return nil
	}
	m.say("reloaded "+version, false)
	m.screen, m.detailID, m.logPath, m.logTitle, m.logFrom = r.Screen, r.Detail, r.LogPath, r.LogTitle, r.LogFrom
	switch m.screen {
	case detailScreen:
		if m.detailID != "" {
			return fetchDetail(m.detailID)
		}
		m.screen = listScreen
	case logScreen:
		if m.logPath != "" {
			return tea.Batch(fetchDetail(m.detailID), fetchLog(m.logPath))
		}
		m.screen = listScreen
	}
	return nil
}
