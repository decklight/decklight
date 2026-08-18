#!/usr/bin/env bash
# Fires just before a release tag is pushed — the last moment anything can be
# fixed, because `git push origin v*` triggers release.yml and npm publishes.
# An npm version cannot be taken back.
#
# WHY THIS EXISTS. Docs and decks drift silently: they are not compiled, not
# imported, and nothing fails when they lie. 0.3.0 nearly shipped with the
# agent skill's indexed description claiming 62 themes when there were 46 —
# the SECOND release that same string went stale — a public site demonstrating
# `decklight edit`, a command removed a release earlier, and a showcase quiz
# grading its audience against a fact the codebase had dropped.
#
# TWO HALVES, HANDLED DIFFERENTLY. The mechanical half (counts, removed
# commands) is checkable, so this runs test/doc-rot.test.mjs and REFUSES the
# push when it fails. The editorial half — whether README covers the commands
# that now exist, whether SPEC's layout matches the tree, whether a terminal
# cast still shows old output — no test can judge, so it is printed as a
# checklist for the human to answer.
#
# Reads the hook payload on stdin, writes a decision as JSON on stdout.
#
# WHEN IT FIRES is pinned by test/release-hook.test.mjs, because the two ways
# this can be wrong are not symmetric. Missing a real tag is the dangerous one.
# Firing on ordinary work is the corrosive one — a warning about something
# permanent, printed on a routine branch push, is a warning people learn to wave
# through, and then it is not there on the day it matters. It shipped with the
# second.

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 0

# ── does this command push refs/tags? ──────────────────────────────────────
#
# It used to grep the WHOLE command string for a `vN.N.N`-shaped word, which
# reads a version number anywhere — including inside a heredoc. It fired on a
# branch push whose commit message happened to contain the example
# `marketplace add acme/themes --branch v2.1.0`: `git push` appeared, a
# version-shaped token appeared, and the two were never connected. A release
# warning that cries wolf on ordinary work is one people learn to wave through,
# which is the opposite of what it is for.
#
# So: isolate the `git push` invocations, and ask GIT whether their arguments
# name tags. release.yml triggers on `tags: ['v*.*.*']`, and this is
# deliberately wider than that pattern — anything that puts a ref under
# refs/tags on the remote is worth stopping for, and being wrong in that
# direction costs a checklist rather than an unpublishable npm version.

# Heredoc bodies are not command arguments. Strip them first, or a commit
# message describing a release reads as one.
strip_heredocs() {
  awk '
    $0 ~ /<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/ && !skip {
      line = $0
      if (match(line, /<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        d = substr(line, RSTART, RLENGTH)
        gsub(/^<<-?[[:space:]]*/, "", d); gsub(/["'"'"']/, "", d)
        delim = d; skip = 1
      }
      print; next
    }
    skip && $0 ~ ("^[[:space:]]*" delim "[[:space:]]*$") { skip = 0; next }
    skip { next }
    { print }
  '
}

# One candidate per line: the segments that actually invoke `git … push`.
push_segments() {
  printf '%s\n' "$cmd" | strip_heredocs \
    | tr '\n;|&' '\n\n\n\n' \
    | grep -E '(^|[[:space:]])git([[:space:]]+-{1,2}[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)'
}

pushes_tags=0
while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  # These push every tag by definition, whatever else is on the line.
  if printf '%s' "$seg" | grep -Eq '(^|[[:space:]])--(tags|follow-tags|mirror)([[:space:]=]|$)'; then
    pushes_tags=1; break
  fi
  prev=''
  for tok in $seg; do
    case "$tok" in
      # everything after an unquoted `#` is a comment, not an argument — and a
      # version number is exactly the kind of thing people write in one
      \#*) break ;;
      -*) prev="$tok"; continue ;;                    # an option, not a refspec
    esac
    # `git push origin tag v0.5.0` — git's own explicit form
    if [ "$prev" = 'tag' ]; then pushes_tags=1; break; fi
    # a refspec pushes its DESTINATION: src:dst, or just the one name
    dst="${tok##*:}"
    case "$dst" in
      refs/tags/*) pushes_tags=1; break ;;
    esac
    # …anything that names a tag THIS repository actually has. Asking git is
    # what makes `v2.1.0` inside a sentence differ from `v2.1.0` as a ref.
    if git rev-parse --verify --quiet "refs/tags/${dst}" >/dev/null 2>&1; then
      pushes_tags=1; break
    fi
    # …and a version-shaped ARGUMENT TO PUSH even when no such tag exists yet,
    # because the release is `git tag v0.6.0 && git push origin v0.6.0` and this
    # runs BEFORE either half. Asking git alone would miss the one command the
    # whole hook exists for. The pattern is release.yml's own (`tags: v*.*.*`),
    # and the difference from the version this replaces is everything: it is a
    # positional argument to `git push`, not a word anywhere in the line.
    case "$dst" in
      v[0-9]*.[0-9]*.[0-9]*) pushes_tags=1; break ;;
    esac
    prev="$tok"
  done
  [ "$pushes_tags" = 1 ] && break
done <<EOF_SEGMENTS
$(push_segments)
EOF_SEGMENTS

[ "$pushes_tags" = 1 ] || exit 0

CHECKLIST='Before this tag publishes — the parts no test can judge:
  · README — does its command table cover every command `decklight help` lists?
  · SPEC REPO_LAYOUT — does the tree it describes match the tree that exists?
  · SPEC NON_GOALS — does it still call something a non-goal that now ships?
  · site/index.html and demo/*.html — do the terminal casts show commands and
    output this version actually produces? (casts are hand-written JSON here,
    `decklight refresh` does not reach them)
  · CHANGELOG.md — every merged PR since the last tag, and the commit count
  · the agent skill (cli/skill-content.mjs) — its indexed description ships
    inside every scaffolded deck and has gone stale twice'

# The mechanical half. Fast (~1s) and decisive.
if ! out="$(node --test test/doc-rot.test.mjs 2>&1)"; then
  # node:test prints the failing entries as diff lines: `  +   'README.md:25 …'`
  failures="$(printf '%s' "$out" | grep -E "^[[:space:]]*\+[[:space:]]+'" \
    | sed -e "s/^[[:space:]]*+[[:space:]]*//" -e "s/,$//" -e "s/^'//" -e "s/'$//" -e "s/^/  · /" | head -20)"
  [ -n "$failures" ] || failures="$(printf '%s' "$out" | grep -E '^✖|AssertionError' | head -10)"
  jq -n --arg f "$failures" --arg c "$CHECKLIST" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("doc-rot tests FAIL — a shipped doc, deck or the agent skill states something the code contradicts:\n" + $f + "\n\nFix these before tagging; npm cannot be unpublished.\n\n" + $c)
    }
  }'
  exit 0
fi

jq -n --arg c "$CHECKLIST" '{
  systemMessage: "release tag push — doc-rot checks pass; editorial checklist injected",
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: ("A RELEASE TAG IS ABOUT TO BE PUSHED. Pushing it runs release.yml and publishes to npm, which is permanent.\n\ntest/doc-rot.test.mjs passes: every theme and pack count in a shipped file matches themes/ and packs.json, and nothing invokes a removed command.\n\n" + $c + "\n\nIf any of these are stale, say so and fix them BEFORE the push rather than after.")
  }
}'
exit 0
