package main

import (
	"reflect"
	"testing"
	"time"

	"github.com/aclemen1/tuikit"
)

func values(kv map[string]string) tuikit.Values {
	var v tuikit.Values
	for k, s := range kv {
		v.Set(k, s)
	}
	return v
}

func TestSchedule(t *testing.T) {
	cases := []struct {
		in   map[string]string
		rule string
	}{
		{map[string]string{"every": "minutes", "interval": "15"}, "FREQ=MINUTELY;INTERVAL=15"},
		{map[string]string{"every": "day", "at": "07:30"}, "FREQ=DAILY;BYHOUR=7;BYMINUTE=30"},
		{map[string]string{"every": "weekdays", "at": "08:00"}, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0"},
		{map[string]string{"every": "week", "at": "18:05", "days": "mo, th"}, "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=18;BYMINUTE=5"},
		{map[string]string{"every": "rrule", "rrule": "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"}, "FREQ=MONTHLY;BYMONTHDAY=-1"},
	}
	for _, c := range cases {
		rule, dtstart, err := schedule(values(c.in))
		if err != nil || rule != c.rule || dtstart != "" {
			t.Errorf("%v: got %q %q %v, want %q", c.in, rule, dtstart, err, c.rule)
		}
	}
	if _, _, err := schedule(values(map[string]string{"every": "week", "at": "08:00", "days": "monday"})); err == nil {
		t.Error("bad days accepted")
	}
	if _, _, err := schedule(values(map[string]string{"every": "minutes", "interval": "0"})); err == nil {
		t.Error("zero minutes accepted")
	}
}

func TestRoutineArgs(t *testing.T) {
	v := values(map[string]string{
		"id": "brief", "description": "Morning brief", "kind": "agent", "acp": "herdr-acp --workspace routine",
		"prompt": "Prepare the brief.", "every": "day", "at": "07:00", "cwd": "~/offices",
	})
	args, id, err := routineArgs(v, nil)
	want := []string{"add", "brief", "--description", "Morning brief", "--rrule", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", "--dtstart", "", "--cwd", "~/offices",
		"--acp-command", "herdr-acp", "--acp-arg=--workspace", "--acp-arg=routine", "--body", "Prepare the brief."}
	if err != nil || id != "brief" || !reflect.DeepEqual(args, want) {
		t.Fatalf("got %q %q %v", args, id, err)
	}

	existing := &routine{ID: "sync", Timeout: "", Run: "true", Rrules: []string{"FREQ=HOURLY"}}
	v = values(map[string]string{"kind": "command", "run": "jj git push", "every": "rrule", "rrule": "FREQ=HOURLY"})
	args, _, _ = routineArgs(v, existing)
	for _, a := range args {
		if a == "--timeout" {
			t.Fatalf("an untouched timeout must not be sent: %q", args)
		}
	}
}

func TestCompactDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{90 * time.Minute: "1h30m", 25 * time.Minute: "25m", 10 * time.Second: "10s", time.Hour: "1h"} {
		if got := compactDuration(d); got != want {
			t.Errorf("%v: got %q, want %q", d, got, want)
		}
	}
}
