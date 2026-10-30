package keymap

import (
	"reflect"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu/keys"
)

func TestAccelerator(t *testing.T) {
	cases := map[string]*keys.Accelerator{
		"":            nil,
		"mod+n":       {Key: "n", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey}},
		"mod+shift+m": {Key: "m", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey, keys.ShiftKey}},
		"shift+alt+f": {Key: "f", Modifiers: []keys.Modifier{keys.ShiftKey, keys.OptionOrAltKey}},
		"mod+\\":      {Key: "\\", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey}},
		"mod++":       {Key: "+", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey}},
		"ctrl+tab":    {Key: "tab", Modifiers: []keys.Modifier{keys.ControlKey}},
		"mod+arrowup": {Key: "up", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey}},
		"f9":          {Key: "f9"},
		"mod+alt+f12": {Key: "f12", Modifiers: []keys.Modifier{keys.CmdOrCtrlKey, keys.OptionOrAltKey}},
		"hyper+x":     nil,
		"mod+mod+x":   nil,
		"mod+unknown": nil,
	}
	for in, want := range cases {
		if got := Accelerator(in); !reflect.DeepEqual(got, want) {
			t.Errorf("Accelerator(%q) = %+v, want %+v", in, got, want)
		}
	}
	for id, c := range Defaults {
		if c != "" && Accelerator(c) == nil {
			t.Errorf("default of %s (%q) is not a valid accelerator", id, c)
		}
	}
}

func TestLabel(t *testing.T) {
	cases := map[string]string{
		"":            "",
		"mod+shift+m": "Ctrl+Shift+M",
		"shift+alt+f": "Shift+Alt+F",
		"mod++":       "Ctrl++",
		"ctrl+tab":    "Ctrl+Tab",
		"mod+\\":      "Ctrl+\\",
		"f8":          "F8",
	}
	for in, want := range cases {
		if got := Label(in); got != want {
			t.Errorf("Label(%q) = %q, want %q", in, got, want)
		}
	}
}
