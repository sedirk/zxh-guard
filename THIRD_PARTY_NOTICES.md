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

zju-connect is a separate executable by Mythologyli and contributors, launched
as a child process. It is **not MIT-licensed** and is **not included** in this
repository or its public plugin packages. The optional installer downloads an
unmodified Windows amd64 release directly from the upstream project.

- Project: https://github.com/Mythologyli/zju-connect
- Pinned release / binaries: https://github.com/Mythologyli/zju-connect/releases/tag/v1.3.1
- Corresponding source: https://github.com/Mythologyli/zju-connect/tree/v1.3.1
- Source download: https://github.com/Mythologyli/zju-connect/archive/refs/tags/v1.3.1.zip
- License: https://github.com/Mythologyli/zju-connect/blob/v1.3.1/LICENSE

The root MIT license does not relicense zju-connect or its dependencies.
If you redistribute the executable yourself, review and comply with its own
license and corresponding-source requirements.
