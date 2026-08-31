package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
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

var version = "dev"

type config struct {
	Server    string `json:"server"`
	DeviceID  string `json:"device_id"`
	Token     string `json:"token"`
	CodexPath string `json:"codex_path"`
	CodexHome string `json:"codex_home"`
}

type pairing struct {
	Code            string `json:"code"`
	Secret          string `json:"secret"`
	VerificationURL string `json:"verification_url"`
}

type pairingStatus struct {
	Status   string `json:"status"`
	DeviceID string `json:"device_id"`
	Token    string `json:"token"`
}

type syncPayload struct {
	BatchID      string    `json:"batch_id"`
	ReportedAt   time.Time `json:"reported_at"`
	Usage        []usage   `json:"usage"`
	Quota        *quota    `json:"quota,omitempty"`
	AgentVersion string    `json:"agent_version"`
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "codex-split:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		fmt.Println("codex-split", version)
		return nil
	}
	if len(args) == 0 {
		return errors.New("usage: codex-split setup|sync|run|status|version")
	}

	switch args[0] {
	case "setup":
		flags := flag.NewFlagSet("setup", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		server := flags.String("server", "", "Codex Split server URL")
		if err := flags.Parse(args[1:]); err != nil || *server == "" {
			return errors.New("usage: codex-split setup --server URL")
		}
		return setup(strings.TrimRight(*server, "/"))
	case "sync":
		if len(args) != 1 {
			return errors.New("usage: codex-split sync")
		}
		return syncOnce()
	case "run":
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		interval := flags.Int("interval", 60, "seconds between syncs")
		if err := flags.Parse(args[1:]); err != nil || *interval < 15 {
			return errors.New("usage: codex-split run [--interval SECONDS], minimum 15")
		}
		for {
			if err := syncOnce(); err != nil {
				fmt.Fprintln(os.Stderr, "sync failed:", err)
			}
			time.Sleep(time.Duration(*interval) * time.Second)
		}
	case "status":
		if len(args) != 1 {
			return errors.New("usage: codex-split status")
		}
		stored, err := loadConfig()
		if err != nil {
			return err
		}
		fmt.Printf("Server: %s\nDevice: %s\n", stored.Server, stored.DeviceID)
		return nil
	default:
		return fmt.Errorf("unknown command %q; use setup, sync, run, status, or version", args[0])
	}
}

func setup(server string) error {
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		return errors.New("Codex is not installed; install it and run `codex login` first")
	}
	if absolute, absoluteErr := filepath.Abs(codexPath); absoluteErr == nil {
		codexPath = absolute
	}
	localCodexHome := codexHome()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	email, err := codexAccountEmail(ctx, codexPath)
	cancel()
	if err != nil {
		return fmt.Errorf("Codex is unavailable or logged out; run `codex login` first: %w", err)
	}
	if err := baselineUsage(localCodexHome); err != nil {
		return fmt.Errorf("prepare local usage baseline: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		return fmt.Errorf("read device name: %w", err)
	}
	var created pairing
	if err := apiJSON(http.MethodPost, server+"/api/pairings", "", map[string]any{
		"name":          hostname,
		"platform":      runtime.GOOS,
		"arch":          runtime.GOARCH,
		"agent_version": version,
		"account_email": email,
	}, &created); err != nil {
		return err
	}

	fmt.Printf("Confirmed ChatGPT account: %s\n", email)
	fmt.Printf("Open %s\nPairing code: %s\nWaiting for device assignment...\n", created.VerificationURL, created.Code)
	_ = openBrowser(created.VerificationURL)

	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		var status pairingStatus
		err := apiJSON(http.MethodPost, server+"/api/pairings/"+created.Code+"/status", "", map[string]string{"secret": created.Secret}, &status)
		if err != nil {
			return err
		}
		if status.Status != "claimed" {
			continue
		}
		if status.DeviceID == "" || status.Token == "" {
			return errors.New("pairing response did not include device credentials")
		}
		if err := saveConfig(config{
			Server: server, DeviceID: status.DeviceID, Token: status.Token,
			CodexPath: codexPath, CodexHome: localCodexHome,
		}); err != nil {
			return err
		}
		fmt.Println("Device connected. Codex Split will only count new usage from this point.")
		if err := syncOnce(); err != nil {
			fmt.Fprintln(os.Stderr, "First sync will be retried by the background service:", err)
		}
		return nil
	}

	return errors.New("pairing timed out; run setup again")
}

func syncOnce() error {
	stored, err := loadConfig()
	if err != nil {
		return err
	}
	next, err := loadState()
	if err != nil {
		return err
	}
	collected, err := collectUsage(next, stored.CodexHome)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	currentQuota, _ := readWeeklyQuota(ctx, stored.CodexPath)
	cancel()
	payload := syncPayload{
		BatchID:      uuid(),
		ReportedAt:   time.Now().UTC(),
		Usage:        collected,
		Quota:        currentQuota,
		AgentVersion: version,
	}
	if err := apiJSON(http.MethodPost, stored.Server+"/api/sync", stored.Token, payload, nil); err != nil {
		return err
	}
	if err := saveState(next); err != nil {
		return err
	}
	fmt.Println("Synced at", time.Now().UTC().Format(time.RFC3339))
	return nil
}

func apiJSON(method, url, token string, requestBody, responseBody any) error {
	encoded, err := json.Marshal(requestBody)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("contact Codex Split: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var serverError struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &serverError)
		if serverError.Message == "" {
			serverError.Message = response.Status
		}
		return errors.New(serverError.Message)
	}
	if responseBody != nil && len(data) > 0 {
		if err := json.Unmarshal(data, responseBody); err != nil {
			return fmt.Errorf("decode Codex Split response: %w", err)
		}
	}
	return nil
}

func openBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func uuid() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}
