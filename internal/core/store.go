package core

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const storeMarker = "gitx-store-v2\n"

var (
	consumerIDPattern = regexp.MustCompile(`^[a-f0-9-]{36}$`)
	objectIDPattern   = regexp.MustCompile(`\b[0-9a-f]{40}\b`)
	packFilePattern   = regexp.MustCompile(`\.(pack|idx|rev)$`)
)

func initializeStore(root string) error {
	if err := os.MkdirAll(root, 0o777); err != nil {
		return err
	}
	marker := filepath.Join(root, ".gitx-store")
	if isPresent(marker) {
		text, err := readText(marker)
		if err != nil {
			return err
		}
		if text != storeMarker {
			return errorf("Invalid git-dedup store marker: %s", root)
		}
		return nil
	}
	if len(readDirNames(root)) > 0 {
		return errorf("Refusing to adopt a nonempty directory as a store: %s", root)
	}
	return writeExclusive(marker, storeMarker)
}

func uniquePackBytes(gitdir string) int64 {
	var total int64
	directory := filepath.Join(gitdir, "objects", "pack")
	for _, name := range readDirNames(directory) {
		if !packFilePattern.MatchString(name) {
			continue
		}
		path := filepath.Join(directory, name)
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if nlink, _, ok := fileIdentity(path); ok && nlink == 1 {
			total += info.Size()
		}
	}
	return total
}

func (c *Client) withLock(root string, action func() error) error {
	// One Git object database needs one writer at a time. Keep the lock outside the store.
	return c.lockDirectory(storeLock(root), func() error {
		if err := initializeStore(root); err != nil {
			return err
		}
		return action()
	})
}

func poolPath(root string) string {
	return filepath.Join(root, "pool.git")
}

type remoteRegistration struct {
	Key    string `json:"key"`
	Remote string `json:"remote"`
}

func registration(remote, key string) string {
	return jsonLine(remoteRegistration{Key: key, Remote: redactRemote(remote, "")})
}

func registerRemote(root, remote, key string) error {
	if err := os.MkdirAll(filepath.Join(root, "remotes"), 0o777); err != nil {
		return err
	}
	return writeText(filepath.Join(root, "remotes", remoteID(key)+".json"), registration(remote, key))
}

type consumerRegistration struct {
	Gitdir string `json:"gitdir"`
}

func registerConsumer(root, id, gitdir string) error {
	if err := os.MkdirAll(filepath.Join(root, "consumers"), 0o777); err != nil {
		return err
	}
	return writeText(filepath.Join(root, "consumers", id+".json"), jsonLine(consumerRegistration{Gitdir: gitdir}))
}

type consumer struct {
	id, gitdir string
}

func registeredConsumers(root string) ([]consumer, error) {
	var consumers []consumer
	for _, name := range readDirNames(filepath.Join(root, "consumers")) {
		text, err := readText(filepath.Join(root, "consumers", name))
		if err != nil {
			return nil, err
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			return nil, errorf("Invalid git-dedup consumer registration: %s", name)
		}
		id := strings.TrimSuffix(name, ".json")
		gitdir, isString := value["gitdir"].(string)
		if !consumerIDPattern.MatchString(id) || !isString {
			return nil, errorf("Invalid git-dedup consumer registration: %s", name)
		}
		consumers = append(consumers, consumer{id: id, gitdir: gitdir})
	}
	return consumers, nil
}

// stateOids lists object IDs that pseudorefs and in-progress rebase or cherry-pick state name; they can
// name fetched commits no ref holds.
func stateOids(gitdir string) []string {
	var files []string
	for _, name := range []string{"FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"} {
		files = append(files, filepath.Join(gitdir, name))
	}
	for _, directory := range []string{"rebase-merge", "rebase-apply", "sequencer"} {
		entries, _ := os.ReadDir(filepath.Join(gitdir, directory))
		for _, entry := range entries {
			if entry.Type().IsRegular() {
				files = append(files, filepath.Join(gitdir, directory, entry.Name()))
			}
		}
	}
	var oids []string
	for _, file := range files {
		oids = append(oids, objectIDPattern.FindAllString(readTextOr(file, ""), -1)...)
	}
	return oids
}

func carriesConsumerID(gitdir, id string) (bool, error) {
	current, err := readText(filepath.Join(gitdir, "gitx-consumer-id"))
	if err != nil {
		if isNotExist(err) || isNotDirectory(err) {
			return false, nil
		}
		return false, err
	}
	return trim(current) == id, nil
}

func isNotDirectory(err error) bool {
	var pathError *fs.PathError
	return errors.As(err, &pathError) && notDirectoryErrno(pathError.Err)
}

func checkoutPath(gitdir string) string {
	if filepath.Base(gitdir) == ".git" {
		return filepath.Dir(gitdir)
	}
	return gitdir
}

func hasAlternate(lines []string, target string) bool {
	return slices.ContainsFunc(lines, func(line string) bool { return samePath(line, target) })
}

func alternateLines(content string) []string {
	var lines []string
	for _, line := range splitLines(content) {
		if line = trim(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func setAlternate(gitdir, pool string) error {
	alternate := filepath.Join(gitdir, "objects", "info", "alternates")
	if err := os.MkdirAll(filepath.Dir(alternate), 0o777); err != nil {
		return err
	}
	target := filepath.Join(pool, "objects")
	lines := alternateLines(readTextOr(alternate, ""))
	if hasAlternate(lines, target) {
		return nil
	}
	return writeText(alternate, strings.Join(append(lines, target), "\n")+"\n")
}

func removeLegacyKeeps(gitdir string) error {
	directory := filepath.Join(gitdir, "objects", "pack")
	for _, name := range readDirNames(directory) {
		if !strings.HasSuffix(name, ".keep") {
			continue
		}
		path := filepath.Join(directory, name)
		if readTextOr(path, "") == "gitx base pack\n" {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	return nil
}

// ownedElsewhere reports whether id is registered to a different gitdir that still carries it, so gitdir
// is a copy (cp -R).
func ownedElsewhere(root, id, gitdir string) (bool, error) {
	text, err := readText(filepath.Join(root, "consumers", id+".json"))
	if err != nil {
		return false, nil
	}
	var value map[string]any
	if json.Unmarshal([]byte(text), &value) != nil {
		return false, nil
	}
	owner, isString := value["gitdir"].(string)
	if !isString || samePath(canonicalPath(owner), canonicalPath(gitdir)) {
		return false, nil
	}
	return carriesConsumerID(owner, id)
}

func consumerID(root, commonGitdir string) (string, error) {
	// Shared across linked worktrees so a tip is pinned only once per object database.
	path := filepath.Join(commonGitdir, "gitx-consumer-id")
	existing := trim(readTextOr(path, ""))
	if consumerIDPattern.MatchString(existing) {
		elsewhere, err := ownedElsewhere(root, existing, commonGitdir)
		if err != nil {
			return "", err
		}
		if !elsewhere {
			return existing, nil
		}
		// A copied checkout must not share the original's pins or registration.
		id := randomUUID()
		return id, writeText(path, id+"\n")
	}
	id := randomUUID()
	err := writeExclusive(path, id+"\n")
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	text, err := readText(path)
	return trim(text), err
}
