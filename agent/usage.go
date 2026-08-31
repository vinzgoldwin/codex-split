package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type state struct {
	Offsets map[string]int64  `json:"offsets"`
	Models  map[string]string `json:"models"`
}

type usage struct {
	Model             string `json:"model"`
	InputTokens       uint64 `json:"input_tokens"`
	CachedInputTokens uint64 `json:"cached_input_tokens"`
	OutputTokens      uint64 `json:"output_tokens"`
}

func baselineUsage(codexRoot string) error {
	baseline := newState()
	err := walkSessions(codexRoot, func(path string) error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		reader := bufio.NewReader(file)
		model := "unknown"
		var offset int64
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				offset += int64(len(line))
				model, _ = parseLogLine(line, model)
			}
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				return readErr
			}
		}
		baseline.Offsets[path] = offset
		baseline.Models[path] = model
		return nil
	})
	if err != nil {
		return err
	}
	return saveState(baseline)
}

func collectUsage(next *state, codexRoot string) ([]usage, error) {
	totals := map[string]*usage{}
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
		}
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return err
		}

		reader := bufio.NewReader(file)
		model := next.Models[path]
		if model == "" {
			model = "unknown"
		}
		committed := offset
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				committed += int64(len(line))
				var sample *usage
				model, sample = parseLogLine(line, model)
				if sample != nil {
					total := totals[model]
					if total == nil {
						total = &usage{Model: model}
						totals[model] = total
					}
					total.InputTokens += sample.InputTokens
					total.CachedInputTokens += sample.CachedInputTokens
					total.OutputTokens += sample.OutputTokens
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				return readErr
			}
		}
		next.Offsets[path] = committed
		next.Models[path] = model
		return nil
	})
	if err != nil {
		return nil, err
	}

	models := make([]string, 0, len(totals))
	for model := range totals {
		models = append(models, model)
	}
	sort.Strings(models)
	result := make([]usage, 0, len(models))
	for _, model := range models {
		result = append(result, *totals[model])
	}
	return result, nil
}

func parseLogLine(line []byte, currentModel string) (string, *usage) {
	var event struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(line, &event) != nil {
		return currentModel, nil
	}
	if event.Type == "turn_context" {
		var payload struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.Model != "" {
			return payload.Model, nil
		}
		return currentModel, nil
	}
	if event.Type != "event_msg" {
		return currentModel, nil
	}
	var payload struct {
		Type string `json:"type"`
		Info *struct {
			LastTokenUsage *struct {
				InputTokens       uint64 `json:"input_tokens"`
				CachedInputTokens uint64 `json:"cached_input_tokens"`
				OutputTokens      uint64 `json:"output_tokens"`
			} `json:"last_token_usage"`
		} `json:"info"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil || payload.Type != "token_count" || payload.Info == nil || payload.Info.LastTokenUsage == nil {
		return currentModel, nil
	}
	return currentModel, &usage{
		Model:             currentModel,
		InputTokens:       payload.Info.LastTokenUsage.InputTokens,
		CachedInputTokens: payload.Info.LastTokenUsage.CachedInputTokens,
		OutputTokens:      payload.Info.LastTokenUsage.OutputTokens,
	}
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
	return &state{Offsets: map[string]int64{}, Models: map[string]string{}}
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
	if err := json.Unmarshal(data, result); err != nil {
		return nil, err
	}
	if result.Offsets == nil {
		result.Offsets = map[string]int64{}
	}
	if result.Models == nil {
		result.Models = map[string]string{}
	}
	return result, nil
}

func saveState(value *state) error {
	return writePrivateJSON("state.json", value)
}

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

func writePrivateJSON(name string, value any) error {
	path, err := dataPath(name)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
