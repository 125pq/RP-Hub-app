# Qwen3.8-27B local deployment benchmark

Tested on 2026-08-23 (Asia/Shanghai).

## Configuration

- GPU: NVIDIA GeForce RTX 4080 SUPER, 16,376 MiB, driver 596.49
- System RAM: 31.41 GiB
- Runtime: official llama.cpp Windows CUDA 13.3 build 10590, commit `6657ded4f`
- Model: `unsloth/Qwen3.8-27B-GGUF`, `UD-IQ4_XS`
- Model file: `Qwen3.8-27B-UD-IQ4_XS.gguf`, 14,252,845,984 bytes
- SHA-256: `40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199`
- Profile: 32,768 context, Q4_0 K/V cache, Flash Attention, parallel 1,
  66/66 layers on CUDA0, Direct I/O, no host model buffer, no mmproj, no MTP,
  prompt RAM cache disabled

## Validation

- CUDA0 detected the RTX 4080 SUPER and the CUDA backend completed inference.
- The startup log reported `offloaded 66/66 layers to GPU` and a
  12,726.35 MiB CUDA0 model buffer.
- The 32K KV cache was 576.00 MiB: 288.00 MiB K Q4_0 and 288.00 MiB V Q4_0.
- Flash Attention was enabled and one request slot was allocated.
- The bundled next-token-prediction tensors were reported unused and ignored;
  no speculative implementation was selected.
- `/v1/models` reported 27,320,697,856 parameters, IQ4_XS 4.25 bpw,
  `n_ctx=32768`, and `n_ctx_train=262144`.
- `/v1/chat/completions` returned valid non-thinking responses.

## 32K API benchmark

One warmed-up OpenAI-compatible chat request used an 869-token prompt and was
forced to a 256-token completion (`finish_reason=length`). Resource values were
sampled during that request.

| Measurement | Result |
| --- | ---: |
| Prompt processing | 1,639.85 tok/s |
| Generation | 37.83 tok/s |
| Prompt time | 529.93 ms |
| Generation time | 6,740.82 ms |
| GPU memory before request | 14,422 MiB |
| Peak GPU memory observed | 14,432 MiB |
| Server working set before request | 1,236.5 MiB |
| Peak server working set observed | 1,399.2 MiB |
| Minimum available system RAM observed | 16.433 GiB |
| Process dedicated GPU memory after request | 13,919.7 MiB |
| Process shared GPU memory after request | 106.0 MiB |

Before the server was started, the machine had 527 MiB GPU memory in use and
17.80 GiB system RAM available. Direct I/O avoids the roughly model-sized physical
RAM working set seen with memory-mapped loading.

## Context scaling observations

Each row completed a real API request with all 66/66 layers on the GPU. The
throughput figures below used tiny prompts and are only useful for showing the
large-context degradation; they are not directly comparable to the 32K benchmark.

| Context | GPU used | GPU free | Shared GPU memory | Generation |
| ---: | ---: | ---: | ---: | ---: |
| 65,536 | 15,142 MiB | 904 MiB | 122 MiB | 34.46 tok/s |
| 98,304 | 15,863 MiB | 183 MiB | 138 MiB | 34.39 tok/s |
| 131,072 | 15,888 MiB | 158 MiB | 850 MiB | 15.61 tok/s |
| 147,456 | 15,992 MiB | 53 MiB | 1,114 MiB | 10.22 tok/s |

The recommended always-on context is 32K. 64K is a reasonable opt-in ceiling;
96K is possible but has too little VRAM headroom for a robust development profile.
The model supports 262K natively, but 128K and above already spill heavily into
Windows shared GPU memory on this machine and conflict with the low-RAM goal.

## Optional native MTP

The same GGUF contains one native MTP/NextN layer. It was enabled with
`draft-mtp`, two draft tokens, an F16 draft KV cache, CUDA0 as the draft device,
and all draft GPU layers requested. The main model remained 66/66 layers on the
GPU. llama.cpp also reported a 521.00 MiB CPU model buffer for MTP; with Direct
I/O, the observed physical working-set increase at 32K was much smaller than the
reported buffer size.

The 32K MTP run repeated the 869-token/256-token API benchmark used above:

| Measurement | MTP result | Non-MTP result |
| --- | ---: | ---: |
| Prompt processing | 1,481.80 tok/s | 1,639.85 tok/s |
| Generation | 61.00 tok/s | 37.83 tok/s |
| Peak GPU memory observed | 15,314 MiB | 14,432 MiB |
| Peak server working set observed | 1,522.5 MiB | 1,399.2 MiB |
| Minimum available system RAM observed | 16.471 GiB | 16.433 GiB |
| Process shared GPU memory after request | 160.0 MiB | 106.0 MiB |
| Draft acceptance | 57.384% | n/a |

MTP improved generation throughput by about 61% on this output while reducing
prompt-processing throughput by about 10%. Acceptance and speed depend on the
prompt and output, so this is a local observation rather than a universal gain.

| MTP context | GPU used | GPU free | Shared GPU memory | Generation | Draft acceptance |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 32,768 | 15,314 MiB peak | 1,062 MiB at peak | 160 MiB | 61.00 tok/s | 57.384% |
| 49,152 | 15,747 MiB | 299 MiB | 176 MiB | 69.65 tok/s | 73.301% |
| 65,536 | 15,724 MiB | 322 MiB | 632 MiB | 54.19 tok/s | 87.568% |

The non-linear dedicated-memory readings at 64K are caused by Windows migrating
more allocations into shared GPU memory. For MTP, 48K is the practical maximum
under the low-system-RAM requirement. 64K is the maximum tested context that
completed inference, but it is an edge profile rather than a safe always-on one.
