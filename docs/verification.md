# Verification record

Environment: Windows, Node.js **v24.18.0**, npm **11.16.0**, TypeScript **5.9.3**. Repository baseline: `9b168715b8911558df6cb1d437fc39bf43999577` (only README). No `AGENTS.md` or `.agents/skills` exists in the repository; checkout was initially clean.

## Automated checks

`npm test` invoked `tsc -p tsconfig.json` and the Node test runner: **46 tests passed, 0 failed, 0 skipped**. `npm run check` and `git diff --check` also passed. All checks execute software behavior locally; they do not infer model quality from mock replies.

- App integration: ingestion, retrieval, two-step offline tool loop, durable archive, new session and resume.
- Configuration/session: exact model IDs, context caps, tool opt-in, infeasible prompt budget rejection, credential URL/cleartext protection, whole-turn pruning and persistence.
- Harness: UTF-8 conservative budgeting, complete tool transactions, pre-request rejection, disabled-tool refusal, final-step tool removal and recoverable interrupted text.
- Memory: deduplication, all source/ordinal occurrences, transactional source replacement/rollback, bounded retrieval/diversity/conjunction recall, Unicode normalization, hostile FTS input, limits and database reopen.
- Provider: fragmented UTF-8/SSE, CRLF/multiline frames, structured tool fragments, usage, disabled tools, final buffered events, cancellation, secret-safe HTTP errors, incomplete/truncated/filter finishes and offline demo.
- Tools: bounded UTF-8 reads/search/writes, traversal/devices/alternate streams, links/junctions/hardlinks, secrets/control paths, exact confirmation, default denial, atomic write and approval-time changes.
- Terminal: cross-delta secret redaction, fragmented escape filtering, fresh interactive-only approvals and piped fallback.

The managed Windows sandbox initially blocked isolated test child processes (`spawn EPERM`). The complete suite passed after running the authorized checks with local process/loopback access. No tests were skipped to work around permission enforcement.

## Interactive checks

Windows ConPTY with `TERM=xterm-256color`: bordered SUN header, explicit preset/active/corpus budgets, history navigation, multiline entry/reset, real-time offline reply, memory/task/status commands, tool opt-in, cancellation, and clean exit. Mock controller checks exercised complete 45-line-plus-tail write review, denial of `yes`, approval of a fresh `y`, rejection of prequeued `y`, cancellation during approval and Ctrl+D. Plain piped input also exercises a sequential task loop.

One-shot offline command succeeded:

```text
node --disable-warning=ExperimentalWarning dist/src/cli.js --demo --prompt "Explain the SUN memory boundary"
```

## Transport evidence and limitations

Real loopback HTTP tests verify request serialization, authentication headers using synthetic keys, status handling and SSE returned in a single response write. Byte-fragmented streaming/parser and cancellation tests use `ReadableStream`-backed mocked fetch responses.

An initial live multipart loopback fixture stalled after its first network chunk in this environment. Independent bare Node clients showed the same behavior; the fixture was replaced with explicit in-process fragmentation plus real single-write HTTP integration. **Live incremental network streaming and actual model inference are therefore unvalidated here.** The transport implementation is present and bounded, but must be checked against the user's compatible backend. No endpoint was secretly substituted.

No model weights, remote model code, paid compute, new credentials, native recurrent-state persistence, vision inference, 1T corpus ingestion or production scale tests were run. The exact two model IDs were inspected through pinned public metadata; publisher claims and displayed benchmark boundaries are recorded in `model-research.md` and `evidence/sources.json`.

## Release

The source ZIP contains source, tests, lockfile, examples, research evidence, documentation and compiled `dist/`. It excludes Git metadata, build dependencies, `.sun/` data, environment files, credentials and local helper scripts. The release archive is checked for integrity and extracted into a fresh workspace for an offline startup smoke test.
