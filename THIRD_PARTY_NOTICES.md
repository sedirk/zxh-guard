# Third-party notices

## MIT-licensed sources

The gateway adapts sanitization, rate limiting and empty-stream handling from
[dsh-zhixiaohang-guard](https://github.com/2277533612/dsh-zhixiaohang-guard),
retry parsing and backoff from
[dsh-cooldown-retry](https://github.com/dboycht/dsh-cooldown-retry), and references
[opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)
for plugin structure. This repository contains modifications, not verbatim
copies of those projects. Their copyright notices are retained below; the
same MIT permission and disclaimer applies to each respective source.

- dsh-zhixiaohang-guard: Copyright (c) 2026 Mika
- dsh-cooldown-retry: Copyright (c) 2026 dboycht
- opencode2pi-desktop: Copyright (c) 2026 Jason Yu

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## zju-connect v1.3.1 — AGPL-3.0

zju-connect is a separate executable by Mythologyli and contributors. It
remains under AGPL-3.0; this project's original code is also AGPL-3.0 (see
`LICENSE`). The executable is an independent process and is not relicensed by
this project.

Distribution forms:

- `*-slim.piplug` does **not** include `zju-connect.exe`. The installer
  downloads the unmodified Windows amd64 v1.3.1 release from upstream and
  verifies its SHA-256.
- `*-full.piplug` includes the unmodified `bin/zju-connect.exe`
  (SHA-256 `AEE7D8DBBF4DB98FBFF2B36D657094D95F3F6209DC3168914C62AEA01A8732BE`),
  the complete AGPL-3.0 text in `LICENSE`, and the Corresponding Source archive
  `third_party/zju-connect-v1.3.1-source.zip`
  (SHA-256 `FA131DDA15A053E4D3D51F2BA0B79278B5129AF6FA7E5AFFC05EAFC2ECA825AB`).
  No modifications were made to zju-connect.

The source archive is also tracked in this repository at
`third_party/zju-connect-v1.3.1-source.zip`.

- Project: https://github.com/Mythologyli/zju-connect
- Pinned release / binaries: https://github.com/Mythologyli/zju-connect/releases/tag/v1.3.1
- Corresponding source: https://github.com/Mythologyli/zju-connect/tree/v1.3.1
- Source download: https://github.com/Mythologyli/zju-connect/archive/refs/tags/v1.3.1.zip
- License: https://github.com/Mythologyli/zju-connect/blob/v1.3.1/LICENSE

The MIT notices above apply only to the MIT-licensed portions; they do not
relicense zju-connect or its dependencies. Keep `LICENSE`, this notice, and the
source archive together when redistributing the full package. Do not add
restrictions beyond AGPL-3.0 for the zju-connect binary.
