package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUpdateChecksHashBeforeStaging(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture is a shell executable")
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	staged := binary + ".next"
	defer os.Remove(staged)
	content := []byte("#!/bin/sh\necho codex-split test-release\n")
	hash := sha256.Sum256(content)
	checksum := "wrong"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/downloads/latest.json" {
			json.NewEncoder(w).Encode(map[string]any{"version": "test-release", "assets": map[string]any{runtime.GOOS + "/" + runtime.GOARCH: map[string]string{"file": "collector", "sha256": checksum}}})
			return
		}
		w.Write(content)
	}))
	defer server.Close()
	if err := saveConfig(config{Server: server.URL, DeviceID: "d", Token: "t", CodexPath: "codex", CodexHome: "codex"}); err != nil {
		t.Fatal(err)
	}
	if stageUpdate() == nil {
		t.Fatal("accepted incorrect checksum")
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatal("staged an unverified binary")
	}
	count := requests
	if err := stageUpdate(); err != nil {
		t.Fatal(err)
	}
	if requests != count {
		t.Fatal("failed update hammered the server")
	}
	path, _ := dataPath("update-checked")
	os.Remove(path)
	checksum = hex.EncodeToString(hash[:])
	if err := stageUpdate(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatal(err)
	}
}

func TestUpgradePreservesPairingAndCheckpoint(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	if err := saveConfig(config{Server: "https://split.test", DeviceID: "d", Token: "t", CodexPath: "codex", CodexHome: filepath.Join(root, "codex")}); err != nil {
		t.Fatal(err)
	}
	next := newState()
	next.Sequence = 10
	next.Offsets["existing"] = 456
	if err := saveState(next); err != nil {
		t.Fatal(err)
	}
	if err := setup("https://split.test"); err != nil {
		t.Fatal(err)
	}
	after, err := loadState()
	if err != nil {
		t.Fatal(err)
	}
	if after.Sequence != 10 || after.Offsets["existing"] != 456 {
		t.Fatal("upgrade reset usage")
	}
	if err := setup("https://different.test"); err == nil {
		t.Fatal("changed server without pairing")
	}
}
