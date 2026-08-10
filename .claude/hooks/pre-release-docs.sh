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

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"

# Only a push that carries a version tag. `git push origin main` is not a
# release; `git push origin v0.3.0` and `git push --tags` are.
if ! printf '%s' "$cmd" | grep -Eq 'git[[:space:]].*push'; then exit 0; fi
if ! printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])v[0-9]+\.[0-9]+\.[0-9]+|--tags|--follow-tags'; then exit 0; fi

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 0

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
