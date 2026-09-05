package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type state struct {
	Offsets  map[string]int64       `json:"offsets"`
	Contexts map[string]*logContext `json:"contexts"`
	Sequence uint64                 `json:"sequence"`
	Pending  *syncPayload           `json:"pending,omitempty"`
	Interval int                    `json:"interval,omitempty"`
	NextSync time.Time              `json:"next_sync,omitempty"`
}

type logContext struct {
	Model string  `json:"model"`
	Tier  string  `json:"tier"`
	Total *uint64 `json:"total,omitempty"`
}

type usage struct {
	Model                 string `json:"model"`
	InputTokens           uint64 `json:"input_tokens"`
	CachedInputTokens     uint64 `json:"cached_input_tokens"`
	CacheWriteInputTokens uint64 `json:"cache_write_input_tokens"`
	OutputTokens          uint64 `json:"output_tokens"`
	ReasoningOutputTokens uint64 `json:"reasoning_output_tokens"`
	ServiceTier           string `json:"service_tier"`
	RecordedAt            string `json:"recorded_at"`
}

func baselineUsage(codexRoot string) error {
	baseline := newState()
	err := walkSessions(codexRoot, func(path string) error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		ctx := &logContext{Model: "unknown", Tier: "unknown"}
		reader := bufio.NewReader(file)
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				baseline.Offsets[path] += int64(len(line))
				parseUsageLine(line, ctx)
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
		}
		baseline.Contexts[path] = ctx
		return nil
	})
	if err != nil {
		return err
	}
	return saveState(baseline)
}

// Preserve request boundaries. One upload covers at most 128 records from one UTC day.
func collectUsage(next *state, codexRoot string) ([]usage, error) {
	result := []usage{}
	day := ""
	stop := errors.New("batch full")
	err := walkSessions(codexRoot, func(path string) error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return err
		}
		offset := next.Offsets[path]
		if offset < 0 || offset > info.Size() {
			offset = 0
			delete(next.Contexts, path)
		}
		ctx := next.Contexts[path]
		if ctx == nil {
			ctx = &logContext{Model: "unknown", Tier: "unknown"}
			// Reconstruct settings and cumulative counters before the old checkpoint once.
			reader := bufio.NewReader(io.LimitReader(file, offset))
			for {
				line, readErr := reader.ReadBytes('\n')
				if len(line) > 0 {
					parseUsageLine(line, ctx)
				}
				if readErr == io.EOF {
					break
				}
				if readErr != nil {
					return readErr
				}
			}
			next.Contexts[path] = ctx
		}
		if _, err = file.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		reader := bufio.NewReader(file)
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				previous := *ctx
				sample := parseUsageLine(line, ctx)
				if sample != nil {
					eventTime, err := time.Parse(time.RFC3339Nano, sample.RecordedAt)
					if err != nil {
						return errors.New("usage record has no valid timestamp")
					}
					sample.RecordedAt = eventTime.UTC().Format(time.RFC3339Nano)
					sampleDay := eventTime.UTC().Format("2006-01-02")
					if day != "" && day != sampleDay {
						*ctx = previous
						return stop
					}
					day = sampleDay
					result = append(result, *sample)
				}
				offset += int64(len(line))
				next.Offsets[path] = offset
				if len(result) >= 128 {
					return stop
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return readErr
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		return nil, err
	}
	return result, nil
}

// Only numeric counters and explicit model/tier metadata leave the device.
func parseUsageLine(line []byte, ctx *logContext) *usage {
	var event struct {
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		Payload   struct {
			Type           string          `json:"type"`
			Model          string          `json:"model"`
			ServiceTier    json.RawMessage `json:"service_tier"`
			ThreadSettings *struct {
				Model       string          `json:"model"`
				ServiceTier json.RawMessage `json:"service_tier"`
			} `json:"thread_settings"`
			Info *struct {
				Last  *usage `json:"last_token_usage"`
				Total *struct {
					Total *uint64 `json:"total_tokens"`
				} `json:"total_token_usage"`
			} `json:"info"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &event) != nil {
		return nil
	}
	p := event.Payload
	if event.Type == "turn_context" {
		if p.Model != "" {
			ctx.Model = p.Model
		}
		if len(p.ServiceTier) > 0 {
			ctx.Tier = parseTier(p.ServiceTier)
		}
	}
	if event.Type != "event_msg" {
		return nil
	}
	if p.Type == "thread_settings_applied" && p.ThreadSettings != nil {
		if p.ThreadSettings.Model != "" {
			ctx.Model = p.ThreadSettings.Model
		}
		ctx.Tier = parseTier(p.ThreadSettings.ServiceTier)
	}
	if p.Type != "token_count" || p.Info == nil || p.Info.Last == nil {
		return nil
	}
	if p.Info.Total != nil && p.Info.Total.Total != nil {
		total := *p.Info.Total.Total
		if ctx.Total != nil && *ctx.Total == total {
			return nil
		}
		ctx.Total = &total
	}
	sample := p.Info.Last
	sample.Model = ctx.Model
	sample.ServiceTier = ctx.Tier
	sample.RecordedAt = event.Timestamp
	return sample
}

func parseTier(raw json.RawMessage) string {
	if string(raw) == "null" {
		return "default"
	}
	var tier string
	if json.Unmarshal(raw, &tier) != nil || tier == "" {
		return "unknown"
	}
	return tier
}

func walkSessions(codexRoot string, visit func(string) error) error {
	sessions := filepath.Join(codexRoot, "sessions")
	if _, err := os.Stat(sessions); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(sessions, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(path), ".jsonl") {
			return visit(path)
		}
		return nil
	})
}
func newState() *state {
	return &state{Offsets: map[string]int64{}, Contexts: map[string]*logContext{}, Interval: 300}
}
func loadState() (*state, error) {
	path, err := dataPath("state.json")
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return newState(), nil
	}
	if err != nil {
		return nil, err
	}
	result := newState()
	if err = json.Unmarshal(data, result); err != nil {
		return nil, err
	}
	if result.Offsets == nil {
		result.Offsets = map[string]int64{}
	}
	if result.Contexts == nil {
		result.Contexts = map[string]*logContext{}
	}
	return result, nil
}
func saveState(value *state) error { return writePrivateJSON("state.json", value) }

func codexHome() string {
	if configured := os.Getenv("CODEX_HOME"); configured != "" {
		return configured
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codex"
	}
	return filepath.Join(home, ".codex")
}

func dataPath(name string) (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root, "codex-split")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	return filepath.Join(directory, name), nil
}

func loadConfig() (config, error) {
	path, err := dataPath("config.json")
	if err != nil {
		return config{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config{}, errors.New("device is not connected; run `codex-split setup --server URL`")
	}
	if err != nil {
		return config{}, err
	}
	var result config
	if err := json.Unmarshal(data, &result); err != nil {
		return config{}, err
	}
	if result.Server == "" || result.DeviceID == "" || result.Token == "" || result.CodexPath == "" || result.CodexHome == "" {
		return config{}, errors.New("device configuration is incomplete; run setup again")
	}
	result.Server = strings.TrimRight(result.Server, "/")
	return result, nil
}

func saveConfig(value config) error {
	return writePrivateJSON("config.json", value)
}

// Write checkpoints atomically so a crash cannot truncate the upload ledger.
func writePrivateJSON(name string, value any) error {
	path, err := dataPath(name)
	if err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".checkpoint-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporary, path)
}
