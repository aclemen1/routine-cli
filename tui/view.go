package main

import (
	"encoding/json"
	"fmt"
	"image/color"
	"regexp"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/aclemen1/tuikit"
	"github.com/charmbracelet/x/ansi"
)

// Colours and their names follow the office TUI.

var darkBackground = true

type adaptive struct{ Light, Dark string }

func (c adaptive) RGBA() (r, g, b, a uint32) {
	if darkBackground {
		return lipgloss.Color(c.Dark).RGBA()
	}
	return lipgloss.Color(c.Light).RGBA()
}

var _ color.Color = adaptive{}

var (
	cAccent  = adaptive{Light: "#5A4FCF", Dark: "#A99CFF"}
	cMuted   = adaptive{Light: "#8A8A8A", Dark: "#6E6E6E"}
	cText    = adaptive{Light: "#1F1F1F", Dark: "#E6E6E6"}
	cOpen    = adaptive{Light: "#1F6FD1", Dark: "#6CB6FF"}
	cWorking = adaptive{Light: "#B7791F", Dark: "#F2C14E"}
	cReady   = adaptive{Light: "#2F855A", Dark: "#68D391"}
	cStopped = adaptive{Light: "#C53030", Dark: "#FC8181"}
	cSelBg   = adaptive{Light: "#ECE9FF", Dark: "#2D2A4A"}
	cSel     = adaptive{Light: "#D4CCFF", Dark: "#4B3F99"}
)

// paneFocused is false while the focus is in another pane.
var paneFocused = true

func fg(c color.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c) }

var (
	sAccent = fg(cAccent).Bold(true)
	sMuted  = fg(cMuted)
	sText   = fg(cText)
	sErr    = fg(cStopped)
	sOK     = fg(cReady)
	sWork   = fg(cWorking)
	sOpen   = fg(cOpen)
)

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07`)

func clean(s string) string {
	return strings.ReplaceAll(ansiRe.ReplaceAllString(s, ""), "\t", "    ")
}

func trunc(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return string(r[:n-1]) + "…"
}

func pad(s string, n int) string {
	s = trunc(s, n)
	if w := len([]rune(s)); w < n {
		s += strings.Repeat(" ", n-w)
	}
	return s
}

// clock shows a time as "Mon 05.10 21:45"; "-" when absent.
func clock(iso string) string {
	t, ok := parseTime(iso)
	if !ok {
		return "-"
	}
	now := time.Now()
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return "today " + t.Format("15:04")
	}
	return t.Format("Mon 02.01 15:04")
}

func statusStyle(status string) lipgloss.Style {
	switch status {
	case "ok":
		return sOK
	case "skipped":
		return sMuted
	case "running":
		return sWork
	default:
		return sErr
	}
}

func (m *model) listHeight() int {
	h := m.height - 5
	if m.legend {
		h -= len(legend())
	}
	if h < 1 {
		h = 1
	}
	return h
}

func (m *model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.ReportFocus = true
	return v
}

func (m *model) render() string {
	if m.width == 0 {
		return ""
	}
	var body []string
	switch m.screen {
	case listScreen:
		body = m.renderList()
	case detailScreen:
		body = m.renderDetail()
	default:
		body = m.renderLog()
	}
	lines := []string{m.header(), ""}
	lines = append(lines, body...)
	footer := m.footer()
	room := m.height - len(footer)
	if len(lines) > room {
		lines = lines[:room]
	}
	for len(lines) < room {
		lines = append(lines, "")
	}
	return tuikit.Overlay(strings.Join(append(lines, footer...), "\n"), m.modal, m.width, m.height)
}

func (m *model) header() string {
	parts := []string{sAccent.Render("routine")}
	if m.loaded {
		s := m.status
		parts = append(parts, sMuted.Render(fmt.Sprintf("%d routines · %d active", s.Routines, s.Active)))
		if len(s.Running) > 0 {
			parts = append(parts, sWork.Render(fmt.Sprintf("%d running", len(s.Running))))
		}
		if s.Invalid > 0 {
			parts = append(parts, sErr.Render(fmt.Sprintf("%d invalid", s.Invalid)))
		}
		if s.Stopped {
			parts = append(parts, sErr.Bold(true).Render("KILL SWITCH ON: nothing runs"))
		}
	}
	if m.newVersion {
		parts = append(parts, sWork.Bold(true).Render("new version: reloads when idle"))
	}
	if m.filter != "" || m.typing {
		cursor := ""
		if m.typing {
			cursor = "▏"
		}
		parts = append(parts, sOpen.Render("filter: "+m.filter+cursor))
	}
	parts = append(parts, sMuted.Render(version))
	return strings.Join(parts, sMuted.Render("  ·  "))
}

func (m *model) footer() []string {
	var lines []string
	if m.legend {
		for _, l := range legend() {
			lines = append(lines, sMuted.Render(trunc(l, m.width)))
		}
	}
	switch {
	case m.msg != "" && m.msgErr:
		lines = append(lines, sErr.Render(trunc(m.msg, m.width)))
	case m.msg != "":
		lines = append(lines, sOK.Render(trunc(m.msg, m.width)))
	case m.listErr != nil:
		lines = append(lines, sErr.Render(trunc("routine: "+m.listErr.Error(), m.width)))
	default:
		lines = append(lines, "")
	}
	var keys string
	switch m.screen {
	case listScreen:
		keys = "enter/l open · c new · E edit · t sort · T reverse · R run · space pause/resume · L last log · o session · # delete · / filter · X kill switch · ? keys · q quit"
	case detailScreen:
		keys = "j/k runs · enter/l log · J/K scroll · R run · space pause/resume · E edit · o session · # delete · esc/h back · q quit"
	default:
		keys = "j/k scroll · J/K page · gg top · G follow · esc/h back · q quit"
	}
	return append(lines, sMuted.Render(trunc(keys, m.width)))
}

func legend() []string {
	return []string{
		"j/k ↓/↑  move   gg/G  top, bottom   enter/l  open   esc/h  back   J/K  scroll the detail   r  reload   q  quit",
		"c  new routine (form)   E  edit (form; the file in $EDITOR for steps)   R  run now   space  pause or resume   e/x/p  pause   u  resume",
		"L  log of the last run   o  the run's ACP session (herdr tab)   #  delete, after typing the id",
		"t  sort by id, next, last run, state, owner   T  reverse   /  filter by id, owner, description   X  kill switch   ?  hide",
	}
}

func (m *model) renderList() []string {
	if !m.loaded {
		return []string{sMuted.Render("loading…")}
	}
	rows := m.rows()
	if len(rows) == 0 {
		if m.filter != "" {
			return []string{sMuted.Render("no routine matches the filter")}
		}
		return []string{sMuted.Render("no routine: add one with `routine add`")}
	}
	idW := 10
	for _, r := range rows {
		if n := len([]rune(r.id())); n > idW {
			idW = n
		}
	}
	const stateW, nextW, lastW = 9, 17, 24
	if max := m.width - stateW - nextW - lastW - 12; idW > max {
		idW = max
	}
	if idW < 8 {
		idW = 8
	}
	// What is left goes to the owner (short), then the description, then the recurrence;
	// each column is no wider than its longest value.
	longestOf := func(header string, value func(*routine) string) int {
		n := len(header)
		for _, r := range rows {
			if r.r != nil && len([]rune(value(r.r))) > n {
				n = len([]rune(value(r.r)))
			}
		}
		return n
	}
	rest := m.width - idW - stateW - nextW - lastW - 10
	ownerW := min(longestOf("OWNER", func(r *routine) string { return r.Owner }), 22, rest/4)
	rest -= ownerW + 2
	descW := min(longestOf("DESCRIPTION", func(r *routine) string { return r.Description }), 60, max(rest/2, rest-50))
	rest -= descW + 2
	recW := min(longestOf("RECURRENCE", func(r *routine) string { return r.Recurrence }), rest)
	col := func(name string) string {
		label := sortLabels[name]
		if m.sortBy != name {
			return label
		}
		if m.sortDesc {
			return label + " ▼"
		}
		return label + " ▲"
	}
	head := "  " + pad(col("id"), idW)
	if descW > 5 {
		head += "  " + pad("DESCRIPTION", descW)
	}
	head += "  " + pad(col("state"), stateW) + "  " + pad(col("next"), nextW) + "  " + pad(col("last"), lastW)
	if recW > 5 {
		head += "  " + pad("RECURRENCE", recW)
	}
	if ownerW > 5 {
		head += "  " + col("owner")
	}
	out := []string{sMuted.Render(head)}

	height := m.listHeight() - 1
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+height {
		m.offset = m.cursor - height + 1
	}
	for i := m.offset; i < len(rows) && i < m.offset+height; i++ {
		r := rows[i]
		var line string
		if r.bad != nil {
			line = sErr.Render(pad(r.bad.ID, idW)+"  "+pad("invalid", stateW)+"  ") + sMuted.Render(trunc(r.bad.Error, m.width-idW-stateW-6))
		} else {
			rt := r.r
			state, st := "active", sOK
			switch {
			case rt.Running:
				state, st = spinner[frame%len(spinner)]+" running", sWork
			case !rt.Active:
				state, st = "paused", sMuted
			}
			next := "-"
			if rt.Next != nil && rt.Active {
				next = clock(*rt.Next)
			}
			last, lst := "-", sMuted
			if rt.Running && rt.RunningSince != "" {
				last, lst = "started "+clock(rt.RunningSince), sWork
			} else if rt.LastRun != nil {
				last, lst = clock(rt.LastRun.Started)+" "+rt.LastRun.Status, statusStyle(rt.LastRun.Status)
			}
			line = sText.Render(pad(rt.ID, idW)) + "  "
			if descW > 5 {
				line += sMuted.Render(pad(rt.Description, descW)) + "  "
			}
			line += st.Render(pad(state, stateW)) + "  " +
				sText.Render(pad(next, nextW)) + "  " + lst.Render(pad(last, lastW))
			if recW > 5 {
				line += "  " + sText.Render(pad(rt.Recurrence, recW))
			}
			if ownerW > 5 {
				line += "  " + sMuted.Render(trunc(rt.Owner, ownerW))
			}
		}
		out = append(out, selectable(line, i == m.cursor, m.width))
	}
	return out
}

// sgrReset matches the resets lipgloss puts after each styled span.
var sgrReset = regexp.MustCompile(`\x1b\[0?m`)

// selectable indents a row; a selected row gets the office TUI's selection: a strong
// background set again after each reset, so the row keeps its colours, and an accent bar.
func selectable(line string, selected bool, w int) string {
	line = "  " + line
	if !selected {
		return line
	}
	sel, mark := color.Color(cSel), color.Color(cAccent)
	if !paneFocused {
		sel, mark = cSelBg, cMuted
	}
	bg, _, _ := strings.Cut(lipgloss.NewStyle().Background(sel).Render("|"), "|")
	rest := ansi.Cut(line, 1, w)
	body := bg + sgrReset.ReplaceAllStringFunc(rest, func(r string) string { return r + bg })
	if pad := w - 1 - lipgloss.Width(rest); pad > 0 {
		body += strings.Repeat(" ", pad)
	}
	bar := lipgloss.NewStyle().Foreground(mark).Background(sel).Bold(true).Render("▌")
	return bar + body + "\x1b[m"
}

func field(name, value string, width int) string {
	return sMuted.Render(pad(name, 10)) + sText.Render(trunc(value, width-10))
}

func (m *model) renderDetail() []string {
	r := m.detail
	if r == nil {
		return []string{sMuted.Render("loading " + m.detailID + "…")}
	}
	w := m.width
	state := "active"
	switch {
	case r.Running:
		state = "running"
	case !r.Active:
		state = "paused"
	}
	label := state
	if state == "running" {
		label = spinner[frame%len(spinner)] + " running"
		if r.RunningSince != "" {
			label += " since " + clock(r.RunningSince)
		}
	}
	lines := []string{sAccent.Render(r.ID) + "  " + statusStyle(map[string]string{"active": "ok", "running": "running", "paused": "skipped"}[state]).Render(label)}
	if r.Description != "" {
		lines = append(lines, sText.Render(trunc(r.Description, w)))
	}
	lines = append(lines, "")
	lines = append(lines, field("when", r.Recurrence, w))
	for _, rule := range r.Rrules {
		lines = append(lines, field("rrule", rule, w))
	}
	if r.Dtstart != "" {
		lines = append(lines, field("dtstart", r.Dtstart, w))
	}
	lines = append(lines, field("tz", r.Tz, w))
	upcoming := make([]string, 0, len(r.Upcoming))
	for _, u := range r.Upcoming {
		upcoming = append(upcoming, clock(u))
	}
	if len(upcoming) == 0 {
		upcoming = []string{"-"}
	}
	lines = append(lines, field("next", strings.Join(upcoming, ", "), w))
	switch {
	case r.Run != "":
		lines = append(lines, field("run", strings.ReplaceAll(r.Run, "\n", " ⏎ "), w))
	case r.Acp != nil:
		lines = append(lines, field("acp", acpLine(r.Acp), w))
	}
	for _, s := range r.Steps {
		what := "run " + strings.ReplaceAll(s.Run, "\n", " ⏎ ")
		if s.Acp != nil {
			what = "acp " + acpLine(s.Acp)
		}
		var extra []string
		if s.TimeoutMs > 0 {
			extra = append(extra, "timeout "+(time.Duration(s.TimeoutMs)*time.Millisecond).String())
		}
		if s.Cwd != "" {
			extra = append(extra, "cwd "+s.Cwd)
		}
		if s.ContinueOnError {
			extra = append(extra, "continue_on_error")
		}
		if len(extra) > 0 {
			what += " [" + strings.Join(extra, ", ") + "]"
		}
		lines = append(lines, field("step", s.Name+": "+what, w))
	}
	lines = append(lines, field("timeout", r.Timeout, w))
	if r.Cwd != "" {
		lines = append(lines, field("cwd", r.Cwd, w))
	}
	if r.Owner != "" {
		lines = append(lines, field("owner", r.Owner, w))
	}
	if r.Meta != nil {
		lines = append(lines, field("meta", compactJSON(r.Meta), w))
	}
	lines = append(lines, field("file", r.File, w), "", sAccent.Render("Runs"))
	if len(m.runs) == 0 {
		lines = append(lines, sMuted.Render("  none yet"))
	}
	for i := 0; i < len(m.runs); i++ {
		run := m.runs[len(m.runs)-1-i]
		kind := "scheduled " + clock(run.Scheduled)
		if run.Manual {
			kind = "manual"
		}
		dur := "-"
		if s, ok1 := parseTime(run.Started); ok1 {
			if e, ok2 := parseTime(run.Ended); ok2 {
				dur = e.Sub(s).Round(time.Second).String()
			}
		}
		line := sText.Render(pad(clock(run.Started), 16)) + "  " + statusStyle(run.Status).Render(pad(run.Status, 8)) + "  " +
			sMuted.Render(pad(dur, 8)+"  "+kind)
		if len(run.Steps) > 0 {
			var steps []string
			for _, s := range run.Steps {
				steps = append(steps, statusStyle(s.Status).Render(s.Name+" "+s.Status))
			}
			line += "  " + strings.Join(steps, sMuted.Render(", "))
		}
		if run.Error != "" {
			line += "  " + sErr.Render(trunc(run.Error, 60))
		}
		lines = append(lines, selectable(line, i == m.runCur, w))
	}
	if strings.TrimSpace(r.Body) != "" {
		lines = append(lines, "", sAccent.Render("Body"))
		for _, l := range strings.Split(strings.TrimRight(r.Body, "\n"), "\n") {
			lines = append(lines, sText.Render(trunc(clean(l), w)))
		}
	}
	if m.scrollDet > len(lines)-1 {
		m.scrollDet = len(lines) - 1
	}
	return lines[m.scrollDet:]
}

func compactJSON(v any) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSpace(b.String())
}

func acpLine(a *acpSpec) string {
	s := strings.Join(append([]string{a.Command}, a.Args...), " ")
	if a.Meta != nil {
		s += " meta " + compactJSON(a.Meta)
	}
	return s + " (close " + a.Close + ", permissions " + a.Permissions + ")"
}

func (m *model) renderLog() []string {
	title := sAccent.Render(m.logTitle) + "  " + sMuted.Render(m.logPath)
	if m.follow {
		title += "  " + sWork.Render("following")
	}
	content := strings.TrimRight(clean(m.logText), "\n")
	if content == "" {
		content = "(empty: this run wrote nothing to its log)"
	}
	text := strings.Split(content, "\n")
	var wrapped []string
	for _, l := range text {
		r := []rune(l)
		for len(r) > m.width {
			wrapped = append(wrapped, string(r[:m.width]))
			r = r[m.width:]
		}
		wrapped = append(wrapped, string(r))
	}
	page := m.height - 5
	if page < 1 {
		page = 1
	}
	maxScroll := len(wrapped) - page
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.follow || m.logScroll > maxScroll {
		m.logScroll = maxScroll
	}
	end := m.logScroll + page
	if end > len(wrapped) {
		end = len(wrapped)
	}
	out := []string{title}
	for _, l := range wrapped[m.logScroll:end] {
		style := sText
		if strings.HasPrefix(l, "=== step ") || strings.HasPrefix(l, "[acp]") {
			style = sAccent
		} else if strings.HasPrefix(l, "[tool]") || strings.HasPrefix(l, "[permission]") {
			style = sMuted
		}
		out = append(out, style.Render(l))
	}
	return out
}
