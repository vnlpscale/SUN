# SUN

A TypeScript AI harness with a streaming terminal interface, resumable sessions, bounded workspace tools, and persistent indexed text memory.

**1T is an experimental logical corpus goal, not a native model context window or a demonstrated capacity.** Every request uses a bounded active window. No trillion-token ingestion, latency, recall, or model-quality claim has been tested.

## Try it

Requires **Node.js 22.13+; Node 24 recommended** with built-in SQLite/FTS5. No runtime packages or model downloads are required.

```powershell
npm ci --ignore-scripts
npm test
npm run demo
```

Source releases include compiled `dist/`, so `npm run demo` also works without installing build dependencies. The demo is deterministic software output, not model inference.

Inside SUN:

```text
/ingest examples/mission.txt
/memory native context
/tools on
/task Explain the SUN mission
/status
/sessions
/quit
```

The amber UI preserves terminal scrollback, streams answers, shows recalled sources and tool progress, supports history arrows and multiline input with a trailing backslash, and cancels a running turn with Ctrl+C. Piped input and redirected output use a plain line interface. Run `/help` for all commands; `/resume <full-id>` restores a saved session. `.sun/` stores local SQLite memory and recent session transcripts. Treat these as private user data.

## Connect your model server

Start a compatible server separately. SUN connects to an OpenAI-compatible `/v1/chat/completions` API; **this project does not install, download or serve the models**. The requested architectures use custom model code, so compatibility with any particular inference server must be validated by its operator.

```powershell
npm start -- --preset speedx27 --endpoint http://127.0.0.1:8000/v1
npm start -- --preset speedx2 --endpoint http://127.0.0.1:8000/v1
```

Set `SUN_API_KEY` through your environment if your endpoint requires authentication. Keys are never accepted in command-line options or printed. Remote endpoints use HTTPS. SUN makes no network calls in `--demo` mode. A user-selected remote endpoint may incur provider charges; no paid endpoint was used in project verification.

```powershell
# A server alias or a related model needs explicit custom configuration.
npm start -- --preset custom --model served-alias --context 8192
# One-shot mode streams text and denies file writes because there is no approval UI.
npm start -- --demo --prompt "Explain SUN"
```

Options: `--demo`, `--preset`, `--model`, `--endpoint`, `--context`, `--output`, `--steps`, `--workspace`, `--tools`, `--prompt`, `--help`. Environment equivalents are `SUN_ENDPOINT`, `SUN_PRESET`, `SUN_MODEL`, `SUN_CONTEXT`, `SUN_OUTPUT`, and `SUN_API_KEY`.

## Model presets and evidence

| Preset | Exact requested model | Operational cap | Capability boundary |
| --- | --- | ---: | --- |
| `speedx27` | `summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64` | 262,144 | Publisher config and prefill/one-token decode benchmark; recall and actual serving untested. Model includes vision; SUN currently sends text only. |
| `speedx2` | `j-llm/Qwen3.5-2B-SpeedX` | 16,384 | Conservative boundary from displayed benchmark. Config claims 262,144 validation; performance/quality above 16K remains untested here. Text only. |
| `custom` | Operator-specified ID | Unknown; harness ceiling 262,144 | Operator must validate the served model's actual context and capabilities. |

Both requested configs explicitly set `native_1T_context=false`. Their 1T position fields describe an experimental logical target. SUN defaults to **8,192 total active tokens**, reserving 1,024 for output. Its UTF-8 byte estimate plus framing margin is conservative for the requested byte-level tokenizer family, but is not an exact tokenizer measurement; custom model templates may require additional margin. Backend context errors are reported without exposing response bodies.

Native API tools are **off by default**. Model templates advertise tool syntax, but that alone does not prove a server can return structured API tool calls. `/tools on` or `--tools` is an explicit operator opt-in. Changing presets disables tools again. Related model names inherit no capabilities automatically. Pinned cards, configs, template metadata and verification status are in [model research](docs/model-research.md).

## Memory and the paper

[SinkRec (arXiv:2606.09888)](https://arxiv.org/html/2606.09888v1) is a sequential recommendation model. Its learned conditional memory and recurrent write/read controls motivate SUN's separation of reusable evidence from the current task. A TypeScript chat client cannot reproduce its trained internal layers.

SUN indexes 4K-character text chunks in SQLite FTS5, deduplicates them by content hash, retains source/ordinal provenance, and diversifies a bounded retrieval shortlist. Source re-ingestion replaces that source's snapshot transactionally. Complete past turns are kept or omitted together to preserve tool-call protocol. Completed user/assistant passages are archived separately from the active transcript. Recalled text is supplied as untrusted evidence with memory IDs.

This is a lexical application-level adaptation. It has no trained RVQ codebook, TDGD state modification, native recurrent-state checkpoints, embedding model, automatic fact validation, or global understanding of the full corpus. Retrieval can miss paraphrases and relevant middle-history passages. The selected prompt is a small subset of memory. See [design and paper mapping](docs/design.md) for concrete boundaries and a scale roadmap.

## Permissions and limits

The model has only `search_memory`, `read_file`, and `write_file`. Reads and ingestion stay inside the selected workspace; traversal, symlinks/junctions, hard links, secret filenames and application control directories are blocked. Writes require approval of the exact target and content every time. The destination parent must exist. File changes are made atomically after rechecking approval-time metadata. There is no shell, arbitrary code execution, model-supplied command execution, or credential acquisition.

Tools are bounded: reads 16 KiB, writes 64 KiB, ingestion 8 MiB per text file, up to four tool calls per step, and six model steps by default (maximum twelve). Transport requests time out after 120 seconds. Single-user local operation is the intended deployment; file checks reduce race risk but are not a security boundary against a hostile process concurrently modifying the workspace. Review saved memory and transcripts before sharing them.

## Verification

`npm test` builds TypeScript and runs actual Node tests covering streaming mock-server connections, fragmented UTF-8/SSE and tools, cancellation, context budgeting, memory persistence/deduplication/provenance/diversity, session resume, and permission enforcement. Offline terminal smoke tests also exercise commands and the task loop. See [verification record](docs/verification.md) for the exact checks run on this build.

Implementation verification did not run actual model inference, vision, paid compute, or weights downloads. See the draft PR for source publication and CI status.
