package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Stage a verified executable. The launcher installs it after this process exits.
func stageUpdate() error {
	stored, err := loadConfig()
	if err != nil {
		return err
	}
	checked, err := dataPath("update-checked")
	if err != nil {
		return err
	}
	if info, err := os.Stat(checked); err == nil && time.Since(info.ModTime()) < 24*time.Hour {
		return nil
	}
	// Back off failed checks too; the launcher calls this once a minute.
	if err = os.WriteFile(checked, []byte(version), 0600); err != nil {
		return err
	}
	var manifest struct {
		Version string `json:"version"`
		Assets  map[string]struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
		} `json:"assets"`
	}
	data, err := download(stored.Server+"/downloads/latest.json", 64*1024)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	if manifest.Version == version {
		return os.WriteFile(checked, []byte(version), 0600)
	}
	asset, ok := manifest.Assets[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return errors.New("no collector release for this platform")
	}
	if filepath.Base(asset.File) != asset.File || strings.ContainsAny(asset.File, "/\\") {
		return errors.New("invalid release filename")
	}
	data, err = download(stored.Server+"/downloads/"+asset.File, 24<<20)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != asset.SHA256 {
		return errors.New("collector checksum mismatch")
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	staged := binary + ".next"
	if runtime.GOOS == "windows" {
		staged = binary + ".next.exe"
	}
	if err = os.WriteFile(staged, data, 0755); err != nil {
		return err
	}
	output, err := exec.Command(staged, "version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "codex-split "+manifest.Version {
		os.Remove(staged)
		return errors.New("new collector failed version check")
	}
	fmt.Println("Staged collector", manifest.Version)
	return os.WriteFile(checked, []byte(manifest.Version), 0600)
}
func download(url string, limit int64) ([]byte, error) {
	response, err := httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("download exceeds size limit")
	}
	return data, nil
}
