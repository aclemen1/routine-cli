package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/aclemen1/tuikit"
)

// Every input of the TUI goes through a tuikit modal: confirmations and the routine form.

func (m *model) openModal(title string, content tuikit.Content, done func(tuikit.Values) tea.Cmd) {
	m.modal = tuikit.NewModal(title, content).SetSize(m.width, m.height)
	m.onDone = done
}

func (m *model) modalDone(msg tuikit.DoneMsg) tea.Cmd {
	done := m.onDone
	m.onDone = nil
	if done == nil {
		return nil
	}
	return done(msg.Values)
}

func (m *model) confirmDelete(id string) {
	m.openModal("Delete "+id, tuikit.NewConfirmTyped("delete", "Type the id to delete "+id+" and its schedule state.", id), func(tuikit.Values) tea.Cmd {
		m.screen = listScreen
		return m.action("delete "+id, id+": deleted", "rm", id)
	})
}

func (m *model) killSwitch() tea.Cmd {
	if m.status.Stopped {
		m.openModal("Kill switch", tuikit.NewConfirm("start", "Restart the schedule? Routines run again on schedule."), func(tuikit.Values) tea.Cmd {
			return m.action("restart the schedule", "schedule restarted", "start")
		})
		return nil
	}
	m.openModal("Kill switch", tuikit.NewConfirm("stop", "Stop every routine? Nothing runs until X again; running ones finish."), func(tuikit.Values) tea.Cmd {
		return m.action("stop every routine", "kill switch on: nothing runs", "stop")
	})
	return nil
}

// ---------------------------------------------------------------- routine form

var (
	idRe      = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$`)
	daysRe    = regexp.MustCompile(`^(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*$`)
	everyKeys = []string{"minutes", "day", "weekdays", "week", "once", "rrule"}
)

const defaultACP = "herdr-acp --workspace routine"

// formable: the form covers a command or ACP routine with one rule, not office's routines nor steps.
func formable(r *routine) (bool, string) {
	switch {
	case strings.HasPrefix(r.ID, "office/"):
		return false, r.ID + " belongs to office: change it with `office routine edit`"
	case len(r.Steps) > 0, len(r.Rrules) > 1:
		return false, ""
	}
	return true, ""
}

func routineForm(r *routine) *tuikit.Form {
	var fields []*tuikit.Field
	if r == nil {
		fields = append(fields, tuikit.Text("id", "Id").Required().Help("lowercase letters, digits, . _ -, segments separated by /"))
	}
	kind, run, prompt, acp, rule := "command", "", "", defaultACP, ""
	if r != nil {
		if r.Acp != nil {
			kind, prompt, acp = "agent", r.Body, strings.Join(append([]string{r.Acp.Command}, r.Acp.Args...), " ")
		} else {
			run = r.Run
		}
		rule = r.Rrules[0]
	}
	every := "day"
	if r != nil {
		every = "rrule"
	}
	desc := tuikit.Text("description", "Description").Help("what the routine does, in one sentence")
	sphere := tuikit.Choice("sphere", "Sphere", "perso", "pro").Required().Default("perso").Help("where its runs are journaled")
	if r != nil && r.Sphere != "" {
		sphere.Default(r.Sphere)
	}
	kindField := tuikit.Choice("kind", "Type", "command", "agent").Required().Default(kind)
	runField := tuikit.TextArea("run", "Command").ShowIf("kind", "command").Required().Help("shell command, run in /bin/zsh -lc")
	promptField := tuikit.TextArea("prompt", "Prompt").ShowIf("kind", "agent").Required()
	acpField := tuikit.Text("acp", "ACP server").ShowIf("kind", "agent").Required().Default(acp).Help("command and arguments")
	if r != nil {
		desc.Default(r.Description)
		if run != "" {
			runField.Default(run)
		}
		if prompt != "" {
			promptField.Default(strings.TrimRight(prompt, "\n"))
		}
	}
	fields = append(fields, desc, sphere, kindField, runField, promptField, acpField,
		tuikit.Choice("every", "Recurrence", everyKeys...).Required().Default(every).
			Help("minutes: every N minutes · day, weekdays, week: at a time · once · rrule: any RRULE"),
		tuikit.Text("interval", "Every (minutes)").ShowIf("every", "minutes").Required().Default("30"),
		tuikit.Clock("at", "At").ShowIf("every", "day", "weekdays", "week").Required().Default("07:00"),
		tuikit.Text("days", "Days").ShowIf("every", "week").Required().Default("MO").Help("MO,TU,WE,TH,FR,SA,SU"),
		tuikit.Date("on", "On").ShowIf("every", "once").Required().Clock("09:00"),
		tuikit.Text("rrule", "RRULE").ShowIf("every", "rrule").Required().Default(rule).Help("e.g. FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0"),
	)
	cwd := tuikit.Text("cwd", "Directory").Help("default: home")
	timeout := tuikit.Duration("timeout", "Timeout").Help("default: 25m")
	if r != nil {
		if r.Cwd != "" {
			cwd.Default(r.Cwd)
		}
		if d, err := time.ParseDuration(r.Timeout); err == nil {
			timeout.Default(d)
		}
	}
	fields = append(fields, cwd, timeout)
	if r == nil {
		fields = append(fields, tuikit.Bool("paused", "Create paused"))
	}
	return tuikit.NewForm("routine", fields...)
}

// schedule turns the form's recurrence into an RRULE and an optional dtstart.
func schedule(v tuikit.Values) (rule, dtstart string, err error) {
	at := v.String("at")
	hour, minute := 0, 0
	if at != "" {
		t, perr := time.Parse("15:04", at)
		if perr != nil {
			return "", "", fmt.Errorf("time: %v", perr)
		}
		hour, minute = t.Hour(), t.Minute()
	}
	clock := fmt.Sprintf("BYHOUR=%d;BYMINUTE=%d", hour, minute)
	switch v.String("every") {
	case "minutes":
		n, perr := strconv.Atoi(strings.TrimSpace(v.String("interval")))
		if perr != nil || n < 1 {
			return "", "", fmt.Errorf("a positive number of minutes")
		}
		return fmt.Sprintf("FREQ=MINUTELY;INTERVAL=%d", n), "", nil
	case "day":
		return "FREQ=DAILY;" + clock, "", nil
	case "weekdays":
		return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;" + clock, "", nil
	case "week":
		days := strings.ToUpper(strings.ReplaceAll(v.String("days"), " ", ""))
		if !daysRe.MatchString(days) {
			return "", "", fmt.Errorf("days as MO,TU,WE,TH,FR,SA,SU")
		}
		return "FREQ=WEEKLY;BYDAY=" + days + ";" + clock, "", nil
	case "once":
		return "FREQ=DAILY;COUNT=1", v.Time("on").Format("2006-01-02T15:04"), nil
	default:
		return strings.TrimSpace(strings.TrimPrefix(v.String("rrule"), "RRULE:")), "", nil
	}
}

type described struct {
	Recurrence string   `json:"recurrence"`
	Upcoming   []string `json:"upcoming"`
}

// validate checks the id and the recurrence with `routine describe`; the sentence it returns
// is shown before saving.
func (m *model) validate(r *routine) func(tuikit.Values) tuikit.Errors {
	return func(v tuikit.Values) tuikit.Errors {
		errs := tuikit.Errors{}
		if r == nil {
			id := strings.TrimSpace(v.String("id"))
			switch {
			case !idRe.MatchString(id):
				errs["id"] = "lowercase letters, digits, . _ -, segments separated by /"
			case strings.HasPrefix(id, "office/"):
				errs["id"] = "office/ belongs to office: use `office routine add`"
			}
			for _, x := range m.list.Routines {
				if x.ID == id {
					errs["id"] = "a routine " + id + " already exists"
				}
			}
		}
		field := map[string]string{"minutes": "interval", "week": "days", "once": "on", "rrule": "rrule"}[v.String("every")]
		if field == "" {
			field = "at"
		}
		rule, dtstart, err := schedule(v)
		if err != nil {
			errs[field] = err.Error()
			return errs
		}
		args := []string{"describe", "--rrule", rule}
		if dtstart != "" {
			args = append(args, "--dtstart", dtstart)
		}
		var d described
		if err := call(&d, args...); err != nil {
			errs[field] = err.Error()
			return errs
		}
		m.preview = d.Recurrence
		return errs
	}
}

func (m *model) openRoutineForm(r *routine) {
	title := "New routine"
	if r != nil {
		title = "Edit " + r.ID
	}
	m.preview = ""
	form := routineForm(r).Validate(m.validate(r))
	m.openModal(title, form, func(v tuikit.Values) tea.Cmd {
		args, id, err := routineArgs(v, r)
		if err != nil {
			m.say(err.Error(), true)
			return nil
		}
		verb, done := "Create", id+": added"
		if r != nil {
			verb, done = "Save", id+": saved"
		}
		m.openModal(verb+" "+id, tuikit.NewConfirm("save", verb+" "+id+": "+m.preview+"?").Default(true), func(tuikit.Values) tea.Cmd {
			return m.action(strings.ToLower(verb)+" "+id, done+" · "+m.preview, args...)
		})
		return nil
	})
}

// routineArgs builds the `routine add` or `routine edit` command from the form.
func routineArgs(v tuikit.Values, r *routine) ([]string, string, error) {
	rule, dtstart, err := schedule(v)
	if err != nil {
		return nil, "", err
	}
	var args []string
	id := strings.TrimSpace(v.String("id"))
	if r == nil {
		args = []string{"add", id}
		if v.Bool("paused") {
			args = append(args, "--paused")
		}
	} else {
		id = r.ID
		args = []string{"edit", id}
	}
	args = append(args, "--description", strings.TrimSpace(v.String("description")), "--sphere", v.String("sphere"), "--rrule", rule, "--dtstart", dtstart, "--cwd", strings.TrimSpace(v.String("cwd")))
	// The timeout is sent only when it changed: an untouched default stays the config's.
	var before time.Duration
	if r != nil {
		before, _ = time.ParseDuration(r.Timeout)
	}
	if d := v.Duration("timeout"); d != before {
		args = append(args, "--timeout", map[bool]string{true: compactDuration(d), false: ""}[d > 0])
	}
	if v.String("kind") == "agent" {
		parts := strings.Fields(v.String("acp"))
		if len(parts) == 0 {
			return nil, "", fmt.Errorf("an ACP server command is needed")
		}
		args = append(args, "--acp-command", parts[0])
		for _, p := range parts[1:] {
			args = append(args, "--acp-arg="+p)
		}
		args = append(args, "--body", v.String("prompt"))
	} else {
		args = append(args, "--run", v.String("run"))
	}
	return args, id, nil
}

// compactDuration writes 1h30m, 25m, 45s: the units routine reads.
func compactDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h, m, sec := int(d.Hours()), int(d.Minutes())%60, int(d.Seconds())%60
	out := ""
	if h > 0 {
		out += fmt.Sprintf("%dh", h)
	}
	if m > 0 {
		out += fmt.Sprintf("%dm", m)
	}
	if sec > 0 || out == "" {
		out += fmt.Sprintf("%ds", sec)
	}
	return out
}

// openEditForm loads the routine's body (show), as a background job, before
// opening its form (editLoaded).
func (m *model) openEditForm(r *routine) tea.Cmd {
	id := r.ID
	return m.busy.Wrap("load "+id+" for editing", func() tea.Msg {
		var full routine
		if err := call(&full, "show", id, "-n", "0"); err != nil {
			return err
		}
		return editLoaded{full}
	})
}
