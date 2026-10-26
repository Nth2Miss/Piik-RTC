# Third-party notices

## Piik

This project vendors and directly imports Piik's React living-room components, production styles, SVG artwork, tooltips, animations, theme controls and locale resources from [TNTcraftHIM/Piik](https://github.com/TNTcraftHIM/Piik), revision `066e218d84a237db41d455975c89a002eb3d0d79`.

The original files are retained under `src/vendor/piik/`. `upstream.json` records their source paths and SHA-256 hashes; `scripts/vendor-piik.mjs` reproduces the import from an upstream checkout. The site favicon is also reused from Piik: `public/favicon.svg` is the upstream `public/favicon.svg` (recorded under `static` in `upstream.json`), and `public/favicon.png`, `public/favicon.ico` and `public/apple-touch-icon.png` are rendered from that SVG. The application adapter in `src/app.tsx` supplies the Agora room model and callbacks, and `src/room-service.ts` owns Agora transport and room API access. Piik's P2P/SFU transport and native desktop capture are not used.

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
