package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func event(tokens int, at string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":%d,"cached_input_tokens":40,"cache_write_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":5},"total_token_usage":{"total_tokens":%d}}}}`+"\n", at, tokens, tokens+20)
}

const settings = `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-6-astra","service_tier":"priority","cwd":"private","developer_instructions":"secret"}}}` + "\n"

func TestRequestFactsAndRepeatedCounters(t *testing.T) {
	ctx := &logContext{Model: "unknown", Tier: "unknown"}
	parseUsageLine([]byte(settings), ctx)
	line := []byte(event(300000, "2026-09-05T10:00:00Z"))
	sample := parseUsageLine(line, ctx)
	if sample == nil || sample.Model != "gpt-6-astra" || sample.ServiceTier != "priority" || sample.CacheWriteInputTokens != 10 || sample.ReasoningOutputTokens != 5 {
		t.Fatalf("unexpected sample: %#v", sample)
	}
	encoded, _ := json.Marshal(sample)
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "secret") {
		t.Fatal("private metadata escaped")
	}
	if parseUsageLine(line, ctx) != nil {
		t.Fatal("repeated cumulative counters counted twice")
	}
	parseUsageLine([]byte(strings.Replace(settings, `"priority"`, `null`, 1)), ctx)
	if ctx.Tier != "default" {
		t.Fatal("explicit null should restore standard")
	}
	parseUsageLine([]byte(`{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-6-astra"}}}`), ctx)
	if ctx.Tier != "unknown" {
		t.Fatal("missing tier should remain unknown")
	}
}

func TestMigrationPartialLinesAndDayBoundary(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "sessions"), 0700)
	path := filepath.Join(root, "sessions", "session.jsonl")
	old := settings + event(100, "2026-09-04T23:59:00Z")
	first := event(200, "2026-09-04T23:59:30Z")
	second := event(300, "2026-09-05T00:00:00Z")
	os.WriteFile(path, []byte(old+first+strings.TrimSuffix(second, "\n")), 0600)
	next := newState()
	next.Offsets[path] = int64(len(old))
	got, err := collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].InputTokens != 200 || got[0].ServiceTier != "priority" {
		t.Fatalf("migration: %#v", got)
	}
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	file.WriteString("\n" + event(400, "2026-09-06T00:00:00Z"))
	file.Close()
	got, err = collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].InputTokens != 300 {
		t.Fatalf("partial/day split: %#v", got)
	}
	got, err = collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].InputTokens != 400 {
		t.Fatalf("next day: %#v", got)
	}
}

func TestBatchLimitDoesNotLoseRequests(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "sessions"), 0700)
	var content strings.Builder
	content.WriteString(settings)
	for i := 0; i < 140; i++ {
		content.WriteString(event(100+i, "2026-09-05T10:00:00Z"))
	}
	os.WriteFile(filepath.Join(root, "sessions", "session.jsonl"), []byte(content.String()), 0600)
	next := newState()
	first, err := collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 128 || len(second) != 12 {
		t.Fatalf("counts %d %d", len(first), len(second))
	}
}

func TestBaselinePreservesSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	os.MkdirAll(filepath.Join(root, "sessions"), 0700)
	path := filepath.Join(root, "sessions", "session.jsonl")
	os.WriteFile(path, []byte(settings+event(100, "2026-09-05T10:00:00Z")), 0600)
	if err := baselineUsage(root); err != nil {
		t.Fatal(err)
	}
	next, err := loadState()
	if err != nil {
		t.Fatal(err)
	}
	got, err := collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatal("baseline recounted")
	}
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	file.WriteString(event(200, "2026-09-05T10:01:00Z"))
	file.Close()
	got, err = collectUsage(next, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ServiceTier != "priority" {
		t.Fatal("settings lost")
	}
}
