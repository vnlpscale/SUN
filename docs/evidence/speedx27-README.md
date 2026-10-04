---
library_name: transformers
pipeline_tag: image-text-to-text
base_model: Qwen/Qwen3.8-27B
license: apache-2.0
tags:
- qwen
- qwen3.8
- multimodal
- recurrent
- gated-delta-net
- custom_code
- experimental
---
# Long-Context VRAM Benchmark

![image](https://cdn-uploads.huggingface.co/production/uploads/69e94913e947e9e6a0ae9d77/c_j7wWsy5ehtPQE0umktm.png)

## Qwen3.8-27B vs SpeedX27-VL-GDN64

We benchmarked long-context VRAM usage of:

* `Qwen/Qwen3.8-27B`
* `summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64`

under the same conditions on an ~80 GiB GPU.

### Configuration

```text
Context limit: 262,144 tokens
Chunk size:    8,192 tokens
Batch size:    1
Precision:     BF16
Cache:         enabled
```

### VRAM scaling

[PASTE BENCHMARK IMAGE HERE]

The difference is clear:

* `Qwen/Qwen3.8-27B` shows increasing VRAM usage as context grows.
* `SpeedX27-VL-GDN64` stays nearly flat at approximately **55.36 GiB** across the full context range.

### Results

| Model             | Model VRAM | Maximum successful context |         Peak VRAM |
| ----------------- | ---------: | -------------------------: | ----------------: |
| Qwen/Qwen3.8-27B  |  50.96 GiB |                    196,608 | 72.82 GiB at 196K |
| SpeedX27-VL-GDN64 |  51.30 GiB |                    262,144 |         55.36 GiB |

The standard model successfully processed **196,608 tokens**, but failed while processing the next 8,192-token chunk.

The GDN64 model successfully completed the full **262,144-token** context.

After the 262K prefill, a one-token decode also succeeded:

```text
Processed context: 262,144 tokens
Maximum chunk peak: 55.36 GiB
Decode success: True
Decode time: 0.123 s
```

### Memory behavior

At 196,608 tokens:

```text
Qwen3.8-27B:     ~72.82 GiB peak
SpeedX27-GDN64:  ~55.36 GiB peak
```

That is approximately **17.46 GiB less peak VRAM** for SpeedX27-GDN64 at the same context length.

More importantly, the scaling behavior is fundamentally different.

```text
Qwen3.8-27B:
VRAM increases with context length.
SpeedX27-GDN64:
VRAM remains nearly constant as context length increases.
```

This benchmark is consistent with the recurrent GDN64 state behaving close to constant-memory with respect to context length, while the standard hybrid architecture retains context-dependent cache growth.

### 262K result

On the tested ~80 GiB GPU:

```text
Qwen/Qwen3.8-27B
196K  -> Success
204K  -> OOM
SpeedX27-VL-GDN64
262K  -> Success
```

The result is not caused by smaller model weights: the GDN64 model actually uses slightly more VRAM immediately after loading.

The advantage appears during long-context inference, where its persistent context-state memory remains nearly flat.


---
