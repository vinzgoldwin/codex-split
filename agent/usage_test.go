package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseLogLine(t *testing.T) {
	model, sample := parseLogLine([]byte(`{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}`), "unknown")
	if model != "gpt-5.6-sol" || sample != nil {
		t.Fatalf("unexpected model event: %q %#v", model, sample)
	}

	model, sample = parseLogLine([]byte(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}}}`), model)
	if sample == nil || model != "gpt-5.6-sol" || sample.InputTokens != 100 || sample.CachedInputTokens != 40 || sample.OutputTokens != 20 {
		t.Fatalf("unexpected usage event: %q %#v", model, sample)
	}
}

func TestBaselineSkipsExistingUsageAndKeepsPartialLine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	sessions := filepath.Join(home, "sessions")
	if err := os.MkdirAll(sessions, 0700); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(sessions, "session.jsonl")
	existing := "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\"}}\n" +
		"{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10}}}}\n"
	if err := os.WriteFile(log, []byte(existing), 0600); err != nil {
		t.Fatal(err)
	}
	if err := baselineUsage(home); err != nil {
		t.Fatal(err)
	}

	partial := `{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20}}}}`
	file, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(partial); err != nil {
		t.Fatal(err)
	}
	file.Close()

	current, err := loadState()
	if err != nil {
		t.Fatal(err)
	}
	first, err := collectUsage(current, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 0 {
		t.Fatalf("partial line was counted: %#v", first)
	}

	file, err = os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		t.Fatal(err)
	}
	file.Close()
	second, err := collectUsage(current, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].InputTokens != 20 || second[0].Model != "gpt-5.6-sol" {
		t.Fatalf("completed line was not counted once: %#v", second)
	}
}
