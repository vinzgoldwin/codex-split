package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

type quota struct {
	UsedPercent        float64   `json:"used_percent"`
	WindowDurationMins int64     `json:"window_duration_mins"`
	ResetsAt           time.Time `json:"resets_at"`
	SampledAt          time.Time `json:"sampled_at"`
}

type rateLimitWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins *int64  `json:"windowDurationMins"`
	ResetsAt           *int64  `json:"resetsAt"`
}

func codexAccountEmail(ctx context.Context, codexPath string) (string, error) {
	var result struct {
		Account *struct {
			Type  string  `json:"type"`
			Email *string `json:"email"`
		} `json:"account"`
	}
	if err := appServerRequest(ctx, codexPath, "account/read", map[string]bool{"refreshToken": true}, &result); err != nil {
		return "", err
	}
	if result.Account == nil {
		return "", errors.New("Codex is not logged in")
	}
	if result.Account.Type != "chatgpt" {
		return "", errors.New("Codex is not using a ChatGPT login")
	}
	if result.Account.Email == nil || *result.Account.Email == "" {
		return "", errors.New("Codex did not report the signed-in ChatGPT email")
	}
	return *result.Account.Email, nil
}

func readWeeklyQuota(ctx context.Context, codexPath string) (*quota, error) {
	var result struct {
		RateLimits struct {
			Primary   *rateLimitWindow `json:"primary"`
			Secondary *rateLimitWindow `json:"secondary"`
		} `json:"rateLimits"`
	}
	if err := appServerRequest(ctx, codexPath, "account/rateLimits/read", map[string]any{}, &result); err != nil {
		return nil, err
	}
	weekly := result.RateLimits.Primary
	if weekly == nil || (result.RateLimits.Secondary != nil && duration(result.RateLimits.Secondary) > duration(weekly)) {
		weekly = result.RateLimits.Secondary
	}
	if weekly == nil || weekly.WindowDurationMins == nil || weekly.ResetsAt == nil {
		return nil, errors.New("Codex did not report a weekly quota window")
	}
	return &quota{
		UsedPercent:        weekly.UsedPercent,
		WindowDurationMins: *weekly.WindowDurationMins,
		ResetsAt:           time.Unix(*weekly.ResetsAt, 0).UTC(),
		SampledAt:          time.Now().UTC(),
	}, nil
}

func duration(window *rateLimitWindow) int64 {
	if window == nil || window.WindowDurationMins == nil {
		return 0
	}
	return *window.WindowDurationMins
}

func appServerRequest(ctx context.Context, codexPath, method string, params, result any) error {
	command := exec.CommandContext(ctx, codexPath, "app-server")
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start `codex app-server`: %w", err)
	}
	defer func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	}()

	encoder := json.NewEncoder(stdin)
	if err := encoder.Encode(map[string]any{
		"id":     1,
		"method": "initialize",
		"params": map[string]any{
			"clientInfo":   map[string]any{"name": "codex-split", "title": "Codex Split", "version": version},
			"capabilities": nil,
		},
	}); err != nil {
		return err
	}
	reader := bufio.NewReader(stdout)
	if err := readRPCResult(reader, 1, nil); err != nil {
		return err
	}
	if err := encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return err
	}
	if err := encoder.Encode(map[string]any{"id": 2, "method": method, "params": params}); err != nil {
		return err
	}
	return readRPCResult(reader, 2, result)
}

func readRPCResult(reader *bufio.Reader, wantedID int, result any) error {
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				return errors.New("Codex app server stopped before responding")
			}
			return err
		}
		var response struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &response) != nil || response.ID != wantedID {
			continue
		}
		if len(response.Error) > 0 && string(response.Error) != "null" {
			return fmt.Errorf("Codex app server error: %s", response.Error)
		}
		if result == nil {
			return nil
		}
		if len(response.Result) == 0 {
			return errors.New("Codex app server response has no result")
		}
		return json.Unmarshal(response.Result, result)
	}
}
