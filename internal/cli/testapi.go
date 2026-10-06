package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/bhouston/git-dedup/internal/core"
	"github.com/bhouston/git-dedup/internal/discover"
)

// testAPIEnv names a file that receives the result of `git-dedup __api <method> <params>`. The shared
// TypeScript test suite drives the Go implementation through it; without the variable, `__api` is an
// ordinary (unknown) Git command.
const testAPIEnv = "GIT_DEDUP_TEST_API"

type apiParams struct {
	Cwd     string   `json:"cwd"`
	GitPath string   `json:"gitPath"`
	Report  bool     `json:"report"`
	Args    []string `json:"args"`
	Path    string   `json:"path"`
	Quiet   bool     `json:"quiet"`
	Remote  string   `json:"remote"`
	Git     string   `json:"git"`
}

type apiResult struct {
	OK      bool                 `json:"ok"`
	Value   any                  `json:"value"`
	Error   string               `json:"error,omitempty"`
	Reports []core.StorageReport `json:"reports"`
}

func testAPI(args []string) (int, bool) {
	resultPath := os.Getenv(testAPIEnv)
	if resultPath == "" || len(args) < 3 || args[0] != "__api" {
		return 0, false
	}
	var params apiParams
	if err := json.Unmarshal([]byte(args[2]), &params); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2, true
	}
	result := apiResult{Reports: []core.StorageReport{}}
	options := core.Options{Cwd: params.Cwd, GitPath: params.GitPath}
	if params.Report {
		options.OnStorageReport = func(report core.StorageReport) { result.Reports = append(result.Reports, report) }
	}
	client := core.New(options)
	code := 0
	var err error
	switch args[1] {
	case "run":
		code, err = client.Run(params.Args)
		result.Value = code
	case "add":
		result.Value, err = client.Add(params.Path, params.Quiet)
	case "remove":
		result.Value, err = client.Remove(params.Path)
	case "storeInfo":
		result.Value = client.StoreInfo()
	case "listRemotes":
		result.Value, err = client.ListRemotes()
	case "fetch":
		result.Value, err = client.Fetch()
	case "gc":
		result.Value, err = client.GC()
	case "prune":
		result.Value, err = client.Prune()
	case "forget":
		result.Value, err = client.Forget(params.Path)
	case "doctor":
		result.Value = client.Doctor()
	case "storePath":
		result.Value = client.StorePath()
	case "gitVersion":
		result.Value, err = client.GitVersion()
	case "gitPath":
		result.Value, err = client.GitPath()
	case "keyForRemote":
		if key := core.KeyForRemote(params.Remote); key != "" {
			result.Value = key
		}
	case "discover":
		result.Value, err = discover.Checkouts(params.Path, params.Git)
	default:
		err = fmt.Errorf("unknown test API method %s", args[1])
	}
	if err != nil {
		result.Error = err.Error()
	} else {
		result.OK = true
	}
	data, marshalErr := marshal(result)
	if marshalErr == nil {
		marshalErr = os.WriteFile(resultPath, data, 0o666)
	}
	if marshalErr != nil {
		fmt.Fprintln(os.Stderr, marshalErr)
		return 2, true
	}
	return code, true
}
