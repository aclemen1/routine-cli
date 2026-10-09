package main

import (
	"fmt"

	"github.com/aclemen1/tuikit"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type screenKind int

const (
	listScreen screenKind = iota
	detailScreen
	logScreen
)

type listMsg struct {
	list   list
	status engineStatus
	err    error
}

type detailMsg struct {
	id      string
	routine routine
	runs    []runRecord
	err     error
}

type logMsg struct {
	path    string
	content string
	err     error
}

type doneMsg struct {
	text string
	err  error
}

type tickMsg time.Time

// A running routine's state spins, like a working agent in the office TUI.
var (
	spinner = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	frame   int
)

type spinMsg struct{}

func spin(every time.Duration) tea.Cmd {
	return tea.Tick(every, func(time.Time) tea.Msg { return spinMsg{} })
}

// spinning: some routine runs. Otherwise the beat slows down, to avoid redrawing for nothing.
func (m *model) spinning() bool {
	for _, r := range m.list.Routines {
		if r.Running {
			return true
		}
	}
	return false
}

type model struct {
	width, height int
	screen        screenKind

	list    list
	status  engineStatus
	cursor  int
	offset  int
	filter  string
	typing  bool
	loaded  bool
	listErr error

	detailID string
	detail   *routine
	runs     []runRecord
	runCur   int

	logFrom   screenKind
	logPath   string
	logTitle  string
	logText   string
	logScroll int
	follow    bool

	binPath    string
	binID      binaryID
	newVersion bool
	reloading  bool
	editing    bool

	sortBy   string
	sortDesc bool
	pendingG bool
	// selectID is the routine asked by --select, applied once the list is loaded.
	selectID string
	selID    string
	saved    savedState

	modal     *tuikit.Modal
	onDone    func(tuikit.Values) tea.Cmd
	preview   string
	legend    bool
	msg       string
	msgErr    bool
	scrollDet int
}

func main() {
	tuikit.SetLanguage(tuikit.English)
	m := &model{follow: true}
	m.restore(loadState())
	for i, arg := range os.Args[1:] {
		switch {
		case arg == "--select" && i+2 < len(os.Args):
			m.selectID = os.Args[i+2]
		case strings.HasPrefix(arg, "--select="):
			m.selectID = strings.TrimPrefix(arg, "--select=")
		}
	}
	if exe, err := os.Executable(); err == nil {
		m.binPath = exe
		m.binID, _ = statBinary(exe)
	}
	p := tea.NewProgram(m)
	listenUSR1(p)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "routine tui:", err)
		os.Exit(1)
	}
	if m.reloading {
		if err := m.execReload(); err != nil {
			fmt.Fprintln(os.Stderr, "routine tui: reload:", err)
			os.Exit(1)
		}
	}
}

func tick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *model) Init() tea.Cmd {
	return tea.Batch(fetchList, tick(), spin(time.Second), checkBinary(), m.resume(), tea.RequestBackgroundColor)
}

func fetchList() tea.Msg {
	l, s, err := loadList()
	return listMsg{l, s, err}
}

func fetchDetail(id string) tea.Cmd {
	return func() tea.Msg {
		r, runs, err := loadDetail(id)
		return detailMsg{id, r, runs, err}
	}
}

func fetchLog(path string) tea.Cmd {
	return func() tea.Msg {
		b, err := os.ReadFile(path)
		return logMsg{path, string(b), err}
	}
}

func action(text string, args ...string) tea.Cmd {
	return func() tea.Msg {
		return doneMsg{text, call(nil, args...)}
	}
}

func (m *model) refresh() tea.Cmd {
	cmds := []tea.Cmd{fetchList}
	if m.screen != listScreen && m.detailID != "" {
		cmds = append(cmds, fetchDetail(m.detailID))
	}
	if m.screen == logScreen && m.logPath != "" {
		cmds = append(cmds, fetchLog(m.logPath))
	}
	return tea.Batch(cmds...)
}

func (m *model) say(text string, isErr bool) {
	m.msg, m.msgErr = text, isErr
}

// rows is the list as shown: routines then invalid files, both filtered.
type row struct {
	r   *routine
	bad *invalid
}

func (r row) id() string {
	if r.r != nil {
		return r.r.ID
	}
	return r.bad.ID
}

func (m *model) rows() []row {
	f := strings.ToLower(m.filter)
	var rows []row
	for i := range m.list.Routines {
		r := &m.list.Routines[i]
		if f == "" || strings.Contains(strings.ToLower(r.ID+" "+r.Owner+" "+r.Description), f) {
			rows = append(rows, row{r: r})
		}
	}
	sortRoutines(rows, m.sortBy, m.sortDesc)
	for i := range m.list.Errors {
		e := &m.list.Errors[i]
		if f == "" || strings.Contains(strings.ToLower(e.ID), f) {
			rows = append(rows, row{bad: e})
		}
	}
	return rows
}

func (m *model) selected() *row {
	rows := m.rows()
	if m.cursor < 0 || m.cursor >= len(rows) {
		return nil
	}
	r := rows[m.cursor]
	return &r
}

// clamp keeps the cursor in the list and records the selected routine.
func (m *model) clamp() {
	rows := m.rows()
	if m.cursor >= len(rows) {
		m.cursor = len(rows) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor < len(rows) {
		m.selID = rows[m.cursor].id()
	}
}

// keepSelection puts the cursor back on the selected routine after the list was reloaded or reordered.
func (m *model) keepSelection() {
	for i, r := range m.rows() {
		if r.id() == m.selID {
			m.cursor = i
			return
		}
	}
	m.clamp()
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		if m.modal.Open() {
			m.modal.SetSize(m.width, m.height)
		}
	case tuikit.DoneMsg:
		m.modal = nil
		cmd := m.modalDone(msg)
		if r := m.checkReload(); r != nil && !m.modal.Open() {
			return m, r
		}
		return m, cmd
	case tuikit.CancelMsg:
		m.modal, m.onDone = nil, nil
		return m, m.checkReload()
	case tea.BackgroundColorMsg:
		darkBackground = msg.IsDark()
	case tea.FocusMsg:
		paneFocused = true
	case tea.BlurMsg:
		paneFocused = false
	case spinMsg:
		if !m.spinning() {
			return m, spin(time.Second)
		}
		frame++
		return m, spin(120 * time.Millisecond)
	case tickMsg:
		return m, tea.Batch(m.refresh(), tick())
	case listMsg:
		m.loaded = true
		m.listErr = msg.err
		if msg.err == nil {
			m.list, m.status = msg.list, msg.status
			m.applySelect()
		}
		m.keepSelection()
	case detailMsg:
		if msg.id != m.detailID {
			break
		}
		if msg.err != nil {
			m.say(msg.err.Error(), true)
			if m.screen == detailScreen {
				m.screen = listScreen
			}
			break
		}
		m.detail, m.runs = &msg.routine, msg.runs
		if m.runCur >= len(m.runs) {
			m.runCur = len(m.runs) - 1
		}
		if m.runCur < 0 {
			m.runCur = 0
		}
	case logMsg:
		if msg.path != m.logPath {
			break
		}
		if msg.err != nil {
			m.logText = "(" + msg.err.Error() + ")"
		} else {
			m.logText = msg.content
		}
	case doneMsg:
		if msg.err != nil {
			m.say(msg.err.Error(), true)
		} else {
			m.say(msg.text, false)
		}
		return m, m.refresh()
	case editedMsg:
		m.editing = false
		cmd := m.edited(msg)
		if r := m.checkReload(); r != nil {
			return m, r
		}
		return m, cmd
	case tea.PasteMsg:
		// A paste (or fast dictation sent as one) goes whole into the active input.
		text := strings.ReplaceAll(msg.Content, "\n", " ")
		switch {
		case m.modal.Open():
			return m, m.modal.Update(msg)
		case m.typing:
			m.filter += text
			m.offset = 0
			m.keepSelection()
		}
		return m, nil
	case binaryCheckMsg:
		return m, m.onBinaryCheck()
	case forceReloadMsg:
		m.newVersion = true
		return m, m.checkReload()
	case tea.KeyPressMsg:
		cmd := m.key(msg)
		m.save()
		if r := m.checkReload(); r != nil {
			return m, r
		}
		return m, cmd
	default:
		// The modal's own messages (cursor blink, completion) go back to it.
		if m.modal.Open() {
			return m, m.modal.Update(msg)
		}
	}
	return m, nil
}

func (m *model) key(k tea.KeyPressMsg) tea.Cmd {
	if m.modal.Open() {
		return m.modal.Update(k)
	}
	if m.typing {
		switch k.String() {
		case "enter":
			m.typing = false
		case "esc":
			m.typing, m.filter = false, ""
		case "backspace":
			if r := []rune(m.filter); len(r) > 0 {
				m.filter = string(r[:len(r)-1])
			}
		case "ctrl+c":
			return tea.Quit
		default:
			m.filter += k.Text
		}
		m.offset = 0
		m.keepSelection()
		return nil
	}
	key := k.String()
	// gg goes to the top: a first g waits for the second.
	if key == "g" {
		if !m.pendingG {
			m.pendingG = true
			return nil
		}
		key = "home"
	}
	m.pendingG = false
	switch key {
	case "q", "ctrl+c":
		return tea.Quit
	case "?":
		m.legend = !m.legend
		return nil
	case "r":
		m.say("", false)
		return m.refresh()
	case "X":
		return m.killSwitch()
	}
	switch m.screen {
	case listScreen:
		return m.listKey(key)
	case detailScreen:
		return m.detailKey(key)
	default:
		return m.logKey(key)
	}
}

func (m *model) listKey(k string) tea.Cmd {
	switch k {
	case "up", "k":
		m.cursor--
	case "down", "j":
		m.cursor++
	case "pgup":
		m.cursor -= m.listHeight() / 2
	case "pgdown":
		m.cursor += m.listHeight() / 2
	case "home":
		m.cursor = 0
	case "end", "G":
		m.cursor = len(m.rows()) - 1
	case "/":
		m.typing = true
	case "c":
		m.openRoutineForm(nil)
		return nil
	case "t":
		m.sortBy = sorts[(sortIndex(m.sortBy)+1)%len(sorts)]
		m.keepSelection()
		m.say("sorted by "+sortLabels[m.sortBy], false)
		return nil
	case "T", "S":
		m.sortDesc = !m.sortDesc
		m.keepSelection()
		return nil
	case "esc":
		m.filter = ""
		m.say("", false)
		m.keepSelection()
		return nil
	case "enter", "l":
		if r := m.selected(); r != nil {
			if r.bad != nil {
				m.say(r.bad.ID+": "+r.bad.Error, true)
				return nil
			}
			return m.openDetail(r.r.ID)
		}
	default:
		if r := m.selected(); r != nil {
			if r.bad != nil {
				if k == "E" || k == "#" || k == "D" {
					return m.routineKey(k, r.bad.ID, r.bad.File, nil)
				}
				return nil
			}
			return m.routineKey(k, r.r.ID, r.r.File, r.r)
		}
	}
	m.clamp()
	return nil
}

func (m *model) openDetail(id string) tea.Cmd {
	m.screen, m.detailID, m.detail, m.runs, m.runCur, m.scrollDet = detailScreen, id, nil, nil, 0, 0
	return fetchDetail(id)
}

func (m *model) detailKey(k string) tea.Cmd {
	switch k {
	case "esc", "backspace", "h", "left":
		m.screen = listScreen
		return fetchList
	case "up", "k":
		if m.runCur > 0 {
			m.runCur--
		}
	case "down", "j":
		if m.runCur < len(m.runs)-1 {
			m.runCur++
		}
	case "J", "ctrl+d":
		m.scrollDet += 3
	case "K", "ctrl+u":
		if m.scrollDet -= 3; m.scrollDet < 0 {
			m.scrollDet = 0
		}
	case "enter", "l":
		if m.runCur < len(m.runs) {
			run := m.runs[len(m.runs)-1-m.runCur]
			return m.openLog(run)
		}
	default:
		if m.detail != nil {
			return m.routineKey(k, m.detail.ID, m.detail.File, m.detail)
		}
	}
	return nil
}

// routineKey holds the actions shared by the list and the detail.
func (m *model) routineKey(k, id, file string, r *routine) tea.Cmd {
	switch k {
	case "R":
		if r != nil && r.Running {
			m.say(id+" is already running", true)
			return nil
		}
		if err := startRun(id); err != nil {
			m.say(err.Error(), true)
			return nil
		}
		m.say(id+": started", false)
		return tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
	case " ", "space":
		if r == nil {
			return nil
		}
		if r.Active {
			return action(id+": paused", "pause", id)
		}
		return action(id+": resumed, missed occurrences are not caught up", "resume", id)
	case "p", "e", "x":
		if r != nil && !r.Active {
			m.say(id+" is already paused", true)
			return nil
		}
		return action(id+": paused", "pause", id)
	case "u":
		if r != nil && r.Active {
			m.say(id+" is already active", true)
			return nil
		}
		return action(id+": resumed, missed occurrences are not caught up", "resume", id)
	case "E":
		if r != nil {
			ok, why := formable(r)
			if why != "" {
				m.say(why, true)
				return nil
			}
			if ok {
				return m.openEditForm(r)
			}
		}
		m.editing = true
		return edit(id, file)
	case "#", "D":
		m.confirmDelete(id)
	case "L":
		if r != nil && r.LastRun != nil {
			return m.openLog(*r.LastRun)
		}
		m.say(id+" has not run yet", true)
	case "o":
		var run *runRecord
		if m.screen == detailScreen && m.runCur < len(m.runs) {
			run = &m.runs[len(m.runs)-1-m.runCur]
		} else if r != nil {
			run = r.LastRun
		}
		session := lastSession(run)
		if session == "" {
			m.say("no ACP session in this run", true)
			return nil
		}
		tab, err := sessionTab(session)
		if err != nil {
			m.say(err.Error(), true)
			return nil
		}
		return func() tea.Msg {
			if err := focusTab(tab); err != nil {
				return doneMsg{err: fmt.Errorf("herdr tab focus %s: %w", tab, err)}
			}
			return doneMsg{text: "session " + short(session) + " is in herdr tab " + tab}
		}
	}
	return nil
}

func (m *model) openLog(run runRecord) tea.Cmd {
	m.logFrom = m.screen
	m.screen, m.logPath, m.logText, m.logScroll, m.follow = logScreen, run.Log, "", 0, true
	m.logTitle = run.ID + " · " + clock(run.Started) + " · " + run.Status
	if m.detailID != run.ID {
		m.detailID = run.ID
	}
	return fetchLog(run.Log)
}

func (m *model) logKey(k string) tea.Cmd {
	page := m.height - 4
	switch k {
	case "esc", "backspace", "h", "left":
		m.screen = m.logFrom
		if m.screen == listScreen {
			return fetchList
		}
		return fetchDetail(m.detailID)
	case "up", "k":
		m.logScroll--
		m.follow = false
	case "down", "j":
		m.logScroll++
	case "pgup", "K", "ctrl+u":
		m.logScroll -= page / 2
		m.follow = false
	case "pgdown", "J", "ctrl+d", " ":
		m.logScroll += page / 2
	case "home":
		m.logScroll, m.follow = 0, false
	case "end", "G", "f":
		m.follow = true
	}
	if m.logScroll < 0 {
		m.logScroll = 0
	}
	return nil
}

type editedMsg struct {
	id  string
	err error
}

// edit opens the routine file in $VISUAL or $EDITOR, then validates it.
func edit(id, file string) tea.Cmd {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "vi"
	}
	cmd := exec.Command("/bin/sh", "-c", editor+` "$1"`, "sh", file)
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return editedMsg{id, err} })
}

func (m *model) edited(msg editedMsg) tea.Cmd {
	if msg.err != nil {
		m.say("editor: "+msg.err.Error(), true)
		return m.refresh()
	}
	var check struct {
		Errors []invalid `json:"errors"`
	}
	// check exits 1 when a file is invalid; its JSON is still on stdout.
	m.say(msg.id+": saved and valid", false)
	if call(&check, "check") == nil {
		for _, e := range check.Errors {
			if e.ID == msg.id {
				m.say(msg.id+" is invalid: "+e.Error, true)
			}
		}
	}
	return m.refresh()
}

// applySelect puts the cursor on the routine named by --select, clearing a filter that hides it.
func (m *model) applySelect() {
	if m.selectID == "" {
		return
	}
	id := m.selectID
	m.selectID = ""
	m.screen = listScreen
	for _, r := range m.list.Routines {
		if r.ID == id {
			m.selID = id
			found := false
			for _, row := range m.rows() {
				if row.id() == id {
					found = true
				}
			}
			if !found {
				m.filter = ""
			}
			return
		}
	}
	for _, e := range m.list.Errors {
		if e.ID == id {
			m.selID, m.filter = id, ""
			return
		}
	}
	m.say("no routine "+id, true)
}
