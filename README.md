# SUN

```text
                 \  |  /
                  .---.
              --- (   ) ---
                  '---'
                 /  |  \

       ____    _   _   _   _
      / ___|  | | | | | \ | |
      \___ \  | | | | |  \| |
       ___) | | |_| | | |\  |
      |____/   \___/  |_| \_|

    A focused window. A persistent archive.
```

**An AI harness for your terminal.** Stream replies, resume tasks, retrieve evidence, and review workspace edits before they happen.

`TypeScript` / `Node.js` / `OpenAI-compatible API` / `SQLite FTS5`

[Quickstart](#quickstart) · [Terminal](#terminal) · [Connect](#connect) · [Models](#models) · [Architecture](#architecture) · [Boundaries](#boundaries)

> **The 1T goal is external indexed memory.** It is an experimental logical corpus target, not a demonstrated capacity or native model context window.

## Quickstart

From a source checkout, use **Node.js 22.13+**; Node 24 is recommended.

```powershell
npm ci --ignore-scripts
npm run build
npm run demo
```

The offline demo needs no model, credentials, runtime packages, or network access. It simulates streaming and the task loop; its replies are deterministic. The source ZIP also includes compiled `dist/`, so it can run `npm run demo` immediately.

## What you get

| Feature | In practice |
| --- | --- |
| Terminal UI | Amber branding, preserved scrollback, streaming replies, history, multiline input and cancellation. |
| Resumable work | Saved sessions and a bounded task/tool loop; six steps by default. |
| External memory | Indexed text chunks, content deduplication, source provenance and diverse lexical retrieval. |
| Deliberate tools | Workspace reads and exact-content write approval; tools start disabled. |
| Grounded presets | Exact model IDs, pinned metadata and conservative operational caps. |

## Terminal

Try this inside the demo:

```text
/ingest examples/mission.txt
/memory native context
/tools on
/task Explain the SUN mission
/status
```

| Command | Purpose |
| --- | --- |
| `/task <goal>` | Run a bounded task; ordinary messages use the same loop. |
| `/ingest <file>` | Index one UTF-8 workspace file; re-ingestion replaces its source snapshot. |
| `/memory <query>` | Inspect recalled passages and sources. |
| `/status` | Inspect model evidence, active budget and indexed corpus statistics. |
| `/model [preset]` | List or select `speedx27`, `speedx2`, or `custom`. |
| `/tools [on\|off]` | Opt into structured API tools for a compatible backend. |
| `/new` · `/sessions` · `/resume <id>` | Start, list or restore sessions; external memory persists. |
| `/help` · `/quit` | Show help or exit. |

Use **↑/↓** for history, a trailing **backslash** for multiline input, **Ctrl+C** to cancel, and **Ctrl+D** to exit. Piped input uses a plain interface and denies file writes. Local `.sun/` memory and transcripts are private user data.

## Connect

Start a compatible model server separately, then connect to its Chat Completions endpoint:

```powershell
npm start -- --preset speedx27 --endpoint http://127.0.0.1:8000/v1
npm start -- --preset speedx2 --endpoint http://127.0.0.1:8000/v1
```

SUN does not download or serve models. These checkpoints use custom architectures; the operator must validate backend compatibility. Remote endpoints require HTTPS. Set `SUN_API_KEY` in your environment if authentication is needed; keys are not accepted as CLI options or printed. A selected remote provider may charge for requests.

```powershell
# Related models or server aliases need explicit configuration.
npm start -- --preset custom --model served-alias --context 8192

# One-shot output; file writes remain denied.
npm start -- --demo --prompt "Explain SUN"
```

Native tools require `/tools on` or `--tools`. Template tool syntax alone does not verify a server's structured-call parser. Changing presets disables tools again.

Run `npm start -- --help` for all options. Supported flags are `--demo`, `--preset`, `--model`, `--endpoint`, `--context`, `--output`, `--steps`, `--workspace`, `--tools`, `--prompt`, and `--help`. Environment settings are `SUN_ENDPOINT`, `SUN_PRESET`, `SUN_MODEL`, `SUN_CONTEXT`, `SUN_OUTPUT`, and `SUN_API_KEY`.

## Models

| Preset | Exact model ID | Operational cap | Evidence boundary |
| --- | --- | ---: | --- |
| `speedx27` | `summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64` | 262,144 | Publisher config and prefill plus one-token decode benchmark; recall untested. |
| `speedx2` | `j-llm/Qwen3.5-2B-SpeedX` | 16,384 | Conservative displayed benchmark boundary; config claims 262,144 validation. |
| `custom` | Operator-specified | Unknown | Harness ceiling is 262,144; verify the served model's actual limit. |

Both requested configs explicitly set **`native_1T_context=false`**. Their 1T position fields describe a logical target. The 27B model includes vision, but SUN's API interface is currently **text only**; the 2B model is text only. Related names inherit no capabilities automatically.

The default active budget is **8,192 tokens total**, with **1,024 reserved for output**. Input accounting uses UTF-8 bytes plus a framing margin, not an exact tokenizer; custom templates may need more margin. [Pinned sources and model research →](docs/model-research.md)

## Architecture

```text
workspace text ----> SQLite archive ----> retrieved evidence
completed turns ---^                           |
                                               v
user task + recent turns ----------------> bounded prompt
                                               |
                                               v
                                        streaming backend
                                               |
                                  answer / permitted tools
```

Memory stores 4K-character chunks with content hashes and source/ordinal provenance. Retrieval selects a small, diverse evidence subset; each task step rebuilds the bounded prompt. Complete past turns stay together so tool-call sequences remain valid. Recalled material is untrusted data, not permission.

[SinkRec (arXiv:2606.09888)](https://arxiv.org/html/2606.09888v1) motivates separating reusable memory from current transitions. SUN adapts that principle at the application level. It does **not** implement learned RVQ codebooks, TDGD layers or native recurrent-state checkpoints. [Design and paper mapping →](docs/design.md)

## Boundaries

- Only `search_memory`, `read_file` and `write_file` exist. There is no shell or arbitrary code-execution tool.
- Reads stay inside the workspace. Traversal, links, secret filenames and control directories are blocked. Every write needs fresh approval of its exact target and content; its parent directory must exist.
- File reads are capped at **16 KiB**, writes at **64 KiB**, and ingestion at **8 MiB per text file**. The loop allows four tool calls per step, six steps by default and twelve maximum. Transport timeout is 120 seconds.
- This is a local, single-user prototype. File rechecks reduce race risk; they do not sandbox a hostile process modifying the workspace concurrently.
- Lexical retrieval can miss paraphrases and relevant passages. **Actual model inference, live incremental network streaming, vision, recall quality and 1T capacity/latency remain unvalidated.**

## Verification

```powershell
npm test
npm run check
```

The verified implementation passed **46 tests, with zero failures or skips**. Coverage includes memory persistence, source replacement, budgets, sessions, fragmented SSE parsing, cancellation, tool permissions and terminal approval safety. Interactive terminal and extracted-release startup checks also passed.

Fragmented stream tests use mocked `ReadableStream` responses; real HTTP tests cover single-write responses, request encoding and status handling. Live multipart loopback streaming stalled in this Windows environment. No actual model inference, weights downloads or paid compute was used. [Full verification record →](docs/verification.md)

---

**Keep the working window focused. Keep the evidence traceable.**
