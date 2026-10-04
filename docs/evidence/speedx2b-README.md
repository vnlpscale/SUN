---
license: apache-2.0
library_name: transformers
pipeline_tag: text-generation
base_model: Qwen/Qwen3.5-2B
tags:
- qwen
- qwen3.5
- recurrent
- rnn
- gated-delta-net
- gdn
- text-generation
- custom_code
- cuda-graph
- fp8
- experimental
---

# Qwen3.5-2B-SpeedX

**Qwen3.5-2B-SpeedX** は、**Qwen/Qwen3.5-2B** をベースに、自己回帰推論の高速化と固定サイズの再帰メモリを目的として変換した、実験的なテキスト専用リカレントモデルです。

元の Qwen3.5-2B のテキストバックボーンは、ネイティブの **Gated DeltaNet（GDN）** レイヤーとフルアテンションレイヤーを組み合わせた構成です。

SpeedX では、6層のフルアテンションレイヤーを蒸留済みのネイティブ GDN レイヤーへ置き換え、**24 / 24 層すべてが再帰的トークンミキシングを行う構成**へ変換しています。

> 本モデルは実験的な研究用チェックポイントであり、Qwen の公式リリースではありません。

## 主な特徴

- 約 1.92B パラメータ
- 24 / 24 層の再帰型 Gated DeltaNet
- フルアテンションレイヤー 3, 7, 11, 15, 19, 23 をネイティブ GDN に置換
- 変換後のテキストスタックでは、トークン単位のフルアテンション KV キャッシュを使用しない
- デコード時の再帰状態サイズはコンテキスト長に対して一定
- カスタムリモートコードを利用した Hugging Face Transformers 互換
- Qwen ネイティブ GDN カーネル向けに設計
- 実験的な Triton / CUDA Graph / FP8 推論ランタイム
- テキスト生成専用
- 上流モデルのマルチモーダル / Vision コンポーネントは含まれない

## アーキテクチャ

元の Qwen3.5-2B テキストスタック：

```text
GDN → GDN → GDN → Full Attention
```

SpeedX：

```text
GDN → GDN → GDN → GDN
```

この構成を全24層にわたって繰り返します。

再帰状態は次式に従います。

\[
S_t = F(S_{t-1}, x_t)
\]

したがって、デコード状態のメモリ使用量はコンテキスト長に対して概ね

\[
M_{\mathrm{state}} = O(1)
\]

となります。

これは、コンテキスト長 \(T\) に応じてメモリ使用量が概ね

\[
M_{\mathrm{KV}} = O(T)
\]

と増加する、トークン単位の Transformer KV キャッシュとは異なります。

## NVIDIA L4 ベンチマーク

単一の **NVIDIA L4 22.03 GiB**、バッチサイズ 1、Greedy Decoding で測定。

### Exact BF16 CUDA Graph

| Context | Official Qwen3.5-2B | SpeedX exact | Speedup |
|---:|---:|---:|---:|
| 256 | 25.90 tok/s | 60.75 tok/s | **2.35×** |
| 1,024 | 26.63 tok/s | 60.58 tok/s | **2.28×** |
| 4,096 | 26.06 tok/s | 60.67 tok/s | **2.33×** |
| 16,384 | 26.46 tok/s | 60.68 tok/s | **2.29×** |

### Experimental FP8 runtime

| Context | Official Qwen3.5-2B | SpeedX FP8 | Speedup |
|---:|---:|---:|---:|
| 256 | 25.90 tok/s | 79.27 tok/s | **3.06×** |
| 1,024 | 26.63 tok/s | 78.85 tok/s | **2.96×** |
| 4,096 | 26.06 tok/s | 78.47 tok/s | **3.01×** |
| 16,384 | 26.46 tok/s | 78.38 tok/s | **2.96×** |

これらの結果は、本プロジェクトの最適化済みランタイムを使用したものです。

標準的な Hugging Face の `model.generate()` で、上記の CUDA Graph / FP8 の性能値をそのまま再現できるとは限りません。

16K コンテキストでは、最適化された Exact Recurrent Path において、おおよそ以下の Prefill 性能を測定しました。

- Official Qwen3.5-2B prefill: **10.85k tok/s**
- SpeedX prefill: **13.79k tok/s**
- Ratio: **約 1.27×**

## クイックスタート

カスタムモデルコードが含まれているため、`trust_remote_code=True` が必要です。

```bash
pip install -U \
  "transformers @ git+https://github.com/huggingface/transformers.git@e453228ef83ce0d756f7621ef8607220ebf5da6a" \
  "kernels>=0.16.0,<0.17" \
  "accelerate>=1.1.0" \
  "safetensors>=0.8.0"
```

```python
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

MODEL_ID = "JLLM/Qwen3.5-2B-SpeedX"

tokenizer = AutoTokenizer.from_pretrained(
    MODEL_ID,
    trust_remote_code=True,
)

model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    trust_remote_code=True,
    torch_dtype=torch.bfloat16,
    device_map="cuda",
).eval()

inputs = tokenizer(
    "Explain recurrent memory in neural networks.",
    return_tensors="pt",
).to("cuda")

with torch.inference_mode():
    output = model.generate(
        **inputs,
        max_new_tokens=128,
        do_sample=False,
    )

print(tokenizer.decode(output[0], skip_special_tokens=True))
```

## チャット例

```python
messages = [
    {"role": "system", "content": "You are a precise technical assistant."},
    {"role": "user", "content": "Compare recurrent state memory with a Transformer KV cache."},
]

text = tokenizer.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
)

inputs = tokenizer(text, return_tensors="pt").to("cuda")

with torch.inference_mode():
    output = model.generate(
        **inputs,
        max_new_tokens=256,
        do_sample=False,
    )

print(tokenizer.decode(output[0], skip_special_tokens=True))
```

## 変換方法

元のテキストスタックには、18層のネイティブ GDN レイヤーと6層のフルアテンションレイヤーが含まれています。

SpeedX は既存のネイティブ GDN レイヤーを維持し、以下のフルアテンションレイヤーを置換します。

```text
3, 7, 11, 15, 19, 23
```

置換先にはネイティブの `Qwen3_5GatedDeltaNet` モジュールを使用します。

置換されたレイヤーは、近傍にあるネイティブ GDN レイヤーを基に初期化し、元のフルアテンションレイヤーの出力を教師として蒸留します。

実験的なレイヤー単位の目的関数では、正規化 MSE と Cosine Distance を組み合わせています。

\[
\mathcal{L}
=
\frac{\|y_S-y_T\|_2^2}
{\mathbb{E}[y_T^2]+\epsilon}
+
\lambda
\left(1-\cos(y_S,y_T)\right).
\]

## 制限事項

### 実験的な蒸留

このチェックポイントは、主として再帰型アーキテクチャへの変換と高速推論ランタイムを検証するために作成されています。

Smoke Distillation の学習スケジュールは短いため、元の Qwen3.5-2B が持つ推論能力、事実知識、多言語性能、各種ベンチマーク性能を完全に維持していると仮定すべきではありません。

本格的な用途では、より長期間の蒸留または継続事前学習を推奨します。

### テキスト専用

上流の Qwen3.5-2B はマルチモーダルモデルですが、SpeedX に含まれるのは変換済みのテキスト生成スタックのみです。

元モデルの Vision スタックは提供されません。

### カスタムコード

以下を有効化する前に、リポジトリ内のコードを確認してください。

```python
trust_remote_code=True
```

### 最適化ランタイムとチェックポイントの違い

約 60 tok/s の Exact 性能、および約 79 tok/s の FP8 性能は、以下を含むランタイム固有の最適化に依存しています。

- ネイティブ GDN カーネル
- Triton Fusion
- Persistent CUDA Graph Greedy Decoding
- 選択的な精度制御 / FP8 実行

通常の Hugging Face 読み込み経路は、主として互換性を提供するためのものです。

## 想定用途

SpeedX は、以下の研究を主な用途として想定しています。

- リカレント言語モデル
- 固定サイズ状態によるデコーディング
- KV キャッシュを使用しないデコーディング
- 長コンテキスト再帰メモリ
- Gated DeltaNet アーキテクチャ
- CUDA Graph 推論
- リカレントモデルの量子化

## デモ

Hugging Face Space：

**JLLM/Qwen-speed**

## ベースモデル

以下のモデルから派生しています。

**Qwen/Qwen3.5-2B**

上流モデルのモデルカードおよびライセンスも併せて確認してください。

## ライセンス

上流の Qwen3.5-2B のモデルメタデータに従い、**Apache-2.0** とします。

## 引用

SpeedX を実験等で使用する場合は、上流の Qwen 関連研究を引用したうえで、本チェックポイントが **Qwen3.5-2B を実験的に再帰型アーキテクチャへ変換したモデル**であることを明記してください。

現時点では、SpeedX 専用の技術レポートは公開されていません。

---

