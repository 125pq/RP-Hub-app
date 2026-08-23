# Local Qwen3.8-27B server

The runtime is installed under `.local/qwen3.8-27b` and is intentionally ignored
by Git. The default profile is local-only, text-only, one request slot, no MTP,
all model layers on `CUDA0`, Q4_0 KV cache, Flash Attention, and a 32,768-token
context.

Port `8080` is the default. `-Port` is available for temporary diagnostics when
another local application already owns that port.

Start from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Start-Qwen3.8-27B.ps1
```

If the 32K profile cannot allocate VRAM, select only one of the approved smaller
contexts; the script never enables CPU model offload:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Start-Qwen3.8-27B.ps1 -ContextSize 24576
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Start-Qwen3.8-27B.ps1 -ContextSize 16384
```

Stop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Stop-Qwen3.8-27B.ps1
```

OpenAI-compatible API base URL: `http://127.0.0.1:8080/v1`

Model ID: `qwen3.8-27b-ud-iq4-xs`

The server defaults to Qwen's thinking-mode sampling values. Clients can override
sampling per request. For non-thinking requests, Qwen recommends temperature
`0.7`, top-p `0.8`, top-k `20`, min-p `0`, presence penalty `1.5`, and repetition
penalty `1.0`.

Direct I/O is used for model loading and the server RAM prompt cache is disabled.
This keeps steady-state system RAM lower than memory-mapped loading while leaving
the GPU-resident slot KV cache enabled.

On the tested RTX 4080 SUPER 16 GB system, 64K is the recommended practical
ceiling for an occasional larger-context session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Start-Qwen3.8-27B.ps1 -ContextSize 65536
```

96K completed a request but left less than 200 MiB of dedicated VRAM available.
128K and 144K caused Windows shared-GPU-memory use to rise sharply and are not
suitable for the low-system-RAM, always-on profile. The model's native context is
262,144 tokens; that is a model limit, not a safe target for this 16 GB card.

MTP remains off by default. To opt in to the tested two-token native MTP draft:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-llm/Start-Qwen3.8-27B.ps1 -EnableMtp
```

The MTP profile uses its recommended F16 draft KV cache. On this machine, 48K is
the practical MTP ceiling and 64K is the tested edge profile. The 64K profile
completed inference but used about 632 MiB of Windows shared GPU memory, so it is
not recommended for the always-on low-RAM configuration.

Example non-thinking API request:

```powershell
$body = @{
    model = 'qwen3.8-27b-ud-iq4-xs'
    messages = @(@{ role = 'user'; content = 'Say hello in one sentence.' })
    max_tokens = 64
    chat_template_kwargs = @{ enable_thinking = $false }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
    -Uri 'http://127.0.0.1:8080/v1/chat/completions' `
    -Method Post `
    -ContentType 'application/json' `
    -Body $body
```
