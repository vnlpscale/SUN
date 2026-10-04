# Verified model and method research

SUN treats one trillion tokens as an **external corpus / logical address-space goal**. It is not a verified native context window, a recall-quality result, or a scale already tested by SUN. Source metadata was retrieved on 2026-10-04; exact times, pinned revisions, URLs and SHA-256 hashes are recorded in [evidence/sources.json](evidence/sources.json).

## What the requested paper actually proposes

[SinkRec, arXiv:2606.09888v1](https://arxiv.org/html/2606.09888v1), submitted June 3, 2026, is a **sequential recommendation** architecture. Repeated behavior patterns can dominate a compressed recurrent state. Its conditional memory encodes contiguous and dilated windows, learns residual vector-quantized codebooks, reinjects retrieved codes and supplies memory key/value pairs. TDGD adds temporal addressing/decay, suppresses writes already explained by memory, and subtracts memory-aligned recurrent readout responses. Learning uses prediction, VQ and reconstruction losses; the hybrid block shares parameters. Fixed memory hyperparameters preserve linear sequence complexity.

The sequence-length study covers **256–4096 user interactions**, not trillion-token LLM prompts. The reported backbone latency comparison excludes the external memory module. The paper does not establish the requested checkpoints' context or recall capabilities.

SUN's justified application-level adaptation is to separate persistent indexed evidence from recent task transitions, deduplicate repeated content and diversify retrieved excerpts. This is **paper-inspired**, not a reproduction: learned VQ, TDGD gates and differential hidden-state readout require model internals and training. A chat API cannot implement them. Lexical hashing/retrieval must never be called residual VQ or TDGD.

## Checkpoints inspected

| Property | 27B SpeedX VL | 2B SpeedX |
| --- | --- | --- |
| Repository | `summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64` | `j-llm/Qwen3.5-2B-SpeedX` |
| Pinned revision | `064d702bc63e20042d00f3308f01509f99a8879f` | `898730fd0900f70f1eccfc864d5136ce0e3b94b4` |
| Architecture in configuration | `Qwen38GDN64VLForConditionalGeneration` | `Qwen35GDN24ForCausalLM` |
| Model type | `qwen3_5`, nested `qwen3_5_text` | `qwen3_5_gdn24` |
| Language layers | 64, all `linear_attention` | 24, all `linear_attention` |
| Hidden size / vocabulary | 5120 / 248320 | 2048 / 248320 |
| Precision metadata | BF16, recurrent-state dtype FP32 | BF16, recurrent-state dtype FP32 |
| Vision | Configuration includes vision stack | Card explicitly excludes vision stack |
| License metadata | Apache-2.0 | Apache-2.0 |
| Remote model code | Custom architecture / `auto_map` | Custom architecture / `auto_map` |

Configuration evidence: [27B pinned config](https://huggingface.co/summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64/resolve/064d702bc63e20042d00f3308f01509f99a8879f/config.json), [2B pinned config](https://huggingface.co/j-llm/Qwen3.5-2B-SpeedX/resolve/898730fd0900f70f1eccfc864d5136ce0e3b94b4/config.json). The 2B configuration lists conversion of former full-attention layers `3, 7, 11, 15, 19, 23`. Both public repositories were accessible without authentication. These are publisher architecture declarations; SUN did not load their weights or verify numerical behavior.

## Context fields: what they do and do not establish

Both pinned configurations contain the following declarations:

| Field | Value | Interpretation for SUN |
| --- | --- | --- |
| `max_position_embeddings` | `1000000000000` | Declared logical positional allowance; insufficient evidence for native recall |
| `speedx_context.logical_context_length` | `1000000000000` | Experimental logical/streaming address-space claim |
| `native_trained_context_length` | `262144` | Publisher training-context metadata, not an independently audited training result |
| `validated_context_length` | `262144` | Publisher validation metadata; distinguish this from displayed benchmark evidence below |
| `native_1T_context` | `false` | Explicit rejection of native 1T context |
| `claim_level` | `experimental_1T_logical_context` | Experimental claim, not validated trillion-token performance |
| `default_chunk_size` | `8192` | Publisher streaming-prefill suggestion |
| `L0_active_tokens.recommended_tokens` | `32768` | Suggested bounded exact-token tier |

The other listed tiers are recurrent state, compressed chunk memory, semantic retrieval and persistent archive. The small published [`speedx_1t_runtime.py`](https://huggingface.co/summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64/resolve/064d702bc63e20042d00f3308f01509f99a8879f/speedx_1t_runtime.py) and [2B runtime](https://huggingface.co/j-llm/Qwen3.5-2B-SpeedX/resolve/898730fd0900f70f1eccfc864d5136ce0e3b94b4/speedx_1t_runtime.py) were read without execution. They retain `past_key_values`, advance an absolute position counter, prefill supplied chunks and invoke a caller's checkpoint callback. They do not implement a retrieval index, summaries, archive storage or restore logic. Hierarchy flags alone therefore do not establish a working external-memory implementation. Remote Python was not copied into SUN.

## Displayed publisher benchmarks

The [27B pinned card](https://huggingface.co/summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64/resolve/064d702bc63e20042d00f3308f01509f99a8879f/README.md) reports an approximately 80 GiB GPU, BF16, batch one, 8192-token chunks and cache enabled. SpeedX completes **262,144-token prefill and one-token decode**, with 55.36 GiB peak and 0.123-second decode. The comparison model completes 196,608 tokens and then runs out of memory. This demonstrates a publisher-reported memory/processing result, not long-range retrieval accuracy; no recall-quality score accompanies it.

The [2B pinned Japanese card](https://huggingface.co/j-llm/Qwen3.5-2B-SpeedX/resolve/898730fd0900f70f1eccfc864d5136ce0e3b94b4/README.md) reports a NVIDIA L4 with 22.03 GiB, batch one and greedy decoding:

| Input context | Original Qwen3.5-2B tok/s | SpeedX BF16 CUDA Graph tok/s | SpeedX experimental FP8 tok/s |
| ---: | ---: | ---: | ---: |
| 256 | 25.90 | 60.75 | 79.27 |
| 1024 | 26.63 | 60.58 | 78.85 |
| 4096 | 26.06 | 60.67 | 78.47 |
| 16384 | 26.46 | 60.68 | 78.38 |

The **displayed 2B measurements stop at 16,384 tokens**, despite the configuration's 262K validation declaration. The card warns that speeds depend on the optimized Triton/CUDA Graph/FP8 runtime and may not reproduce through standard `model.generate()`. It describes short smoke distillation and says retained reasoning, knowledge, multilingual and benchmark quality should not be assumed. Its example identifier `JLLM/Qwen3.5-2B-SpeedX` differs from the requested, accessible repository; SUN uses `j-llm/Qwen3.5-2B-SpeedX` exactly. Neither benchmark was rerun locally.

## Tokenizer, chat and serving constraints

Both declare `Qwen2Tokenizer`, vocabulary size 248320, EOS `<|im_end|>`, padding `<|endoftext|>` and `model_max_length=1000000000000`. The tokenizer length flag is metadata, not recall validation. Small selected tokenizer fields and exact separate templates are in `docs/evidence`; complete tokenizer vocabularies were not downloaded.

Both separate templates describe XML-style `tool_call`, `function` and `parameter` blocks and tool-response turns. That establishes template intent, **not tested OpenAI structured-tool-call support**. Server adapters/parsers must be checked separately. No tool should execute merely because these tags appear in generated text. The 2B tokenizer configuration has no embedded template; its separate template still accepts image/video placeholders despite the absent vision stack. Keep the 2B preset text-only.

The 27B template defaults thinking on and accepts `xhigh`, `medium`, `low` reasoning effort. The 2B template starts thinking only when explicitly enabled. These settings are template options; an OpenAI-compatible server must support forwarding them. SUN does not assume stock vLLM, SGLang or llama.cpp supports the modified architectures. Connect to a server that the user has already configured; SUN's TypeScript client does not load weights or execute remote model code. Generic Hugging Face deployment snippets are not compatibility tests.

## Harness adaptation and scale contract

For a runnable application, maintain exact recent task turns separately from immutable, source-attributed archived chunks. Store checksums and offsets, suppress duplicate retrieval results, and budget evidence excerpts before sending a request. Preserve changed requirements and recent transitions even when old corpus content repeats. This is an engineering adaptation of the paper's decoupling principle, not its learned neural mechanism.

A conservative operational starting window is **32K for the 27B preset and 16K for the 2B preset**; a deployment may need smaller windows. Any larger server window requires user configuration and validation. Prompt budgets must include system instructions, tools/template overhead, selected memory and reserved output; a character/byte estimate is not an exact Qwen tokenizer count.

External corpus storage grows with corpus size. A local index, counter or schema accepting `1_000_000_000_000` does not prove feasible 1T ingestion, recall or latency. At that goal, sharded storage, partitioned indexes, incremental ingestion, aggregate routing, bounded retrieval and failure recovery need substantial engineering and measurement. Keep disk bytes, corpus token estimates, selected evidence and active model window separately visible. Related model names inherit no capabilities automatically; use explicit custom settings and verified model-specific evidence.

## Verification status

- **Verified here:** primary paper HTML read; public model metadata fetched; small source files pinned, size-bounded and hashed; configuration/card differences recorded.
- **Publisher claims:** architecture, training/validation context fields, recurrent memory characteristics and all throughput/VRAM numbers.
- **Not tested here:** actual model serving, tool-call parser behavior, vision, persistent neural state, inference quality, >16K 2B behavior, 1T ingestion/recall, or production scaling.
- **No inference blocker to hide:** this research requires a user-provided compatible serving endpoint before model behavior can be validated. Offline harness/mock tests verify software behavior only.
