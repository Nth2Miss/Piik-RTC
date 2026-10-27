# Third-party notices

Piik-RTC itself is licensed under the MIT License; see [LICENSE](LICENSE). The notices below cover third-party components included in this repository.

## Piik

This project vendors and directly imports Piik's React living-room components, production styles, SVG artwork, tooltips, animations, theme controls and locale resources from [TNTcraftHIM/Piik](https://github.com/TNTcraftHIM/Piik), revision `066e218d84a237db41d455975c89a002eb3d0d79`.

The original files are retained under `src/vendor/piik/`. `upstream.json` records their source paths and SHA-256 hashes; `scripts/vendor-piik.mjs` reproduces the import from an upstream checkout. The site favicon is also reused from Piik: `public/favicon.svg` is the upstream `public/favicon.svg` (recorded under `static` in `upstream.json`), and `public/favicon.png`, `public/favicon.ico` and `public/apple-touch-icon.png` are rendered from that SVG. The application adapter in `src/app.tsx` supplies the room model and callbacks, and `src/room-service.ts` and `src/rtc-client.ts` provide room API access and RTC transport integration. Piik's P2P/SFU transport and native desktop capture are not used.

Copyright (c) 2026 TNTcraft and Piik contributors

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

## Microsoft Edge WebView2

The Windows desktop host uses the [Microsoft Edge WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) runtime installed on the machine and the `Microsoft.Web.WebView2` SDK. The runtime is not bundled with Piik-RTC; it is a system component governed by the Microsoft Edge terms. The SDK's managed assemblies and loader are redistributed as part of the single-file host under their license.

## .NET

The desktop host runs on .NET Framework 4.8, which is a Windows component. The native audio helper (`desktop/native/PiikAudio`) is published as a self-contained .NET 9 application. .NET is distributed under the MIT License; the runtime license and third-party notices are included with the published helper.

## Volcengine RTC token sample

The token encoder in `server/providers/volc/token.js` follows the [Volcengine RTC demo](https://github.com/volcengine/rtc-aigc-demo), distributed under the BSD 3-Clause License.

Copyright 2025 Beijing Volcano Engine Technology Co., Ltd. All Rights Reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
