package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestPendingBatchSurvivesFailureAndAcknowledgement(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload syncPayload
		json.NewDecoder(r.Body).Decode(&payload)
		if payload.Sequence != 7 || payload.BatchID != "durable-batch" {
			t.Errorf("retry changed identity: %#v", payload)
		}
		calls++
		if calls == 1 {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"sync_interval_seconds":300,"idle_interval_seconds":900}`))
	}))
	defer server.Close()
	if err := saveConfig(config{Server: server.URL, DeviceID: "device", Token: "token", CodexPath: "not-invoked", CodexHome: filepath.Join(root, "codex")}); err != nil {
		t.Fatal(err)
	}
	next := newState()
	next.Sequence = 7
	next.Offsets["private-file"] = 123
	next.Pending = &syncPayload{Protocol: 2, Sequence: 7, BatchID: "durable-batch"}
	if err := saveState(next); err != nil {
		t.Fatal(err)
	}
	if syncOnce() == nil {
		t.Fatal("expected failure")
	}
	retry, err := loadState()
	if err != nil {
		t.Fatal(err)
	}
	if retry.Pending == nil || retry.Offsets["private-file"] != 123 {
		t.Fatal("pending checkpoint lost")
	}
	if err = syncOnce(); err != nil {
		t.Fatal(err)
	}
	done, err := loadState()
	if err != nil {
		t.Fatal(err)
	}
	if done.Pending != nil || done.Sequence != 7 || done.Interval != 900 {
		t.Fatal("bad acknowledgement")
	}
}
