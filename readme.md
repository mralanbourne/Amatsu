<p align="center">
  <img src="https://raw.githubusercontent.com/mralanbourne/Amatsu/main/static/amatsu_large.png" width="300" alt="Amatsu Logo">
</p>

<h1 align="center">AMATSU: Your Heavenly Gateway</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-7.7.6-42a5f5.svg?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Status-Online-success?style=for-the-badge" alt="Status Online">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready">
</p>

<p align="center">
  <strong>The definitive high-performance bridge between Nyaa.si and Stremio. Access the world's largest library of high-quality Anime and Live Action Content via Real-Debrid or Torbox with bulletproof episode parsing, a strict 3-phase sorting engine, multi-language subtitle injection, and zero server-side tracking.</strong><br />
  🍏 Fully Compatible with Stremio Web (Linux / iOS / iPadOS) & AIOStreams 💙
</p>

<div align="center">
  <h3>🌐 Community Instance</h3>
  <a href="https://amatsu.onrender.com/">amatsu.onrender.com</a>
  <br />
  <br />
  <a href="https://amatsu.onrender.com/">
    <img src="https://img.shields.io/badge/INSTALL_NOW-CLICK_HERE-42a5f5?style=for-the-badge&logo=rocket" alt="Install Button" height="55">
  </a>
</div>

<br />

> [!WARNING]
> ### ⚠️ MUST READ: Addon Quirks & Limitations
> Nyaa is the gold standard for Asian releases, but naming conventions vary wildly. Amatsu uses no backend database to store results, resolving everything on-the-fly. Keep these UI quirks in mind:
> 
> 1. 🖼️ **The "Blue Posters" (Working as intended):** During a global search, obscure Nyaa results will appear as blue text-only posters to keep the search lightning fast. **This is not a bug!** The real Posters, description, and episode count are fetched dynamically the moment you click on the title.
> 2. 🎭 **Mismatched Metadata:** Because the addon matches messy P2P titles against strict databases like AniList, it will sometimes guess wrong and display the wrong poster in the catalog. **Don't panic!** The actual video streams are fetched directly from Nyaa based on the raw title, so the video content remains correct.
> 3. 👻 **Dynamic Episode Discovery:** If metadata APIs don't know how many episodes a series has (common for OVAs or new releases), Amatsu scrapes Nyaa titles to detect the actual episode count dynamically.
> 4. 🎬 **The "Loading" Video (Uncached Torrents):** If you click an uncached stream (`☁️ Download`), Stremio will start playing a looping "Waiting/Loading" video. **This is not an error!** It means Amatsu sent the torrent to your Debrid cloud. Wait a bit, back out, and click again to see the live progress (e.g., `[⏳ 45% RD]`) or Check your Debrid Dashboard.

> [!IMPORTANT]
> ### 🔒 Privacy & Zero-Knowledge Security
> * Amatsu is built on a **Stateless Architecture**. Unlike other addons, your sensitive data never touches a database.
> * **Base64 Config:** Your Debrid keys and Language preferences are stored exclusively in your personal Manifest URL using secure Base64 encoding.
> * **Direct Resolution:** Stream links are resolved on-the-fly and redirected directly to your player.
> * **100% Open Source:** Your security is paramount. Verify the code yourself. Everything is public.

### 🌙 Quick Start
1. Open the [Community Instance](https://amatsu.onrender.com/) and enter your Real-Debrid and / or Torbox API Key.
2. Select your **Preferred Languages** (e.g., GER, JPN, ENG) from the setup grid. Order matters!
3. Choose your catalog preferences (Trending / Top Rated).
4. Click "Install" or copy your manifest url to add your personalized configuration to Stremio.
5. Use the global Stremio search. Results will natively appear under the **Amatsu Search** catalogs.

### ✨ Key Features & Next-Gen Engine Upgrades
* **🍏 Apple iOS & Flatpak Ready:** Amatsu features a heavily hardened CORS and Preflight (`OPTIONS`) architecture, guaranteeing seamless stream and subtitle loading on strict WebKit browsers (iPhone/iPad Safari) and Linux sandboxes.
* **🧠 3-Phase Multi-Pass Sorter:** The stream sorting engine guarantees absolute precision. Streams are strictly cascaded by:  <br /> **1. Language Priority & Cache Status ➔ 2. Video Resolution (8K down to SD) ➔ 3. File Size**. 
* **🚀 Smart Movie & OVA Bypass:** No more false-negative drops! Amatsu's adaptive parser perfectly differentiates between single-file movies and multi-episode series, ensuring that release years (2019), versions (v2), or audio channels (5.1) are never mistaken for episode numbers.
* **📦 Bulletproof Batch Routing:** Say goodbye to episode hijacking. Amatsu intelligently recognizes international batch formats (like Spanish `01 a 12` or `01 to 12`) and isolates exact individual files inside massive 100+ episode torrent chunks.
* **⛩️ Aggressive Unicode Sanitization:** Advanced reverse-digit extraction safely captures Japanese volume markers (第, 巻), single-character tags (E05), and effortlessly matches heavily punctuated titles by normalizing all special characters.
* **🛡️ Precision Subtitle Proxy:** External `.ass`, `.srt`, `.vtt`, and `.ssa` files are automatically scrubbed, proxied with bandwidth-leak protection, and injected into the Stremio player as selectable tracks.
* **⚡ Debrid API Protection:** Built-in Promise deduplication and LRU caching protect your Real-Debrid and Torbox accounts from rate limits during heavy binge-watching sessions.

---

<details>
<summary>💻 <strong>Self-Hosting Instructions (Developers)</strong></summary>

### Hosting your own Gateway
Amatsu is optimized for Oracle and PaaS environments.

#### 1. Prerequisites
* **Node.js:** v18 or higher.
* **Docker & Docker-Compose** (Recommended).

#### 2. Deployment (Docker Compose)
1. **Clone the Repo:**

`git clone https://github.com/mralanbourne/Amatsu.git`
`cd Amatsu`

2. **Build and Run:**

`docker-compose up -d`

Amatsu will start on Port 7002.

**Environment Variables:**
* `BASE_URL`: **REQUIRED**. Your public domain (e.g. `https://amatsu.yourdomain.com`). Amatsu requires this to correctly construct the Subtitle-Proxy and Stream-Resolver links.
* `ROOT_TORBOX_KEY`: **REQUIRED** (if supporting Torbox). Master Torbox API Key utilized for backend operations and fallback Cache status requests NOTHING ELSE. provides RD Users with an approximation if their Content is on RD cause the normal RD Request is heavily rate limited which is why we ask Torbox. in 99% of cases Stuff that is on TB is on RD.
* `PORT`: Optional. Defaults to 7002.
* `NYAA_DOMAIN`: Optional. Specify a custom Nyaa mirror (e.g. `https://nyaa.iss.one`) if the main domain is blocked in your region.
* `PROXY_URL`: Optional. Pass traffic through a secure proxy (e.g. `http://user:pass@host:port`) to bypass aggressive Cloudflare challenges or ISP blocks.

</details>

<p align="center">☕ Support</p>

<p align="center">I maintain this instance for the community. If you enjoy seamless access to Nyaa, consider supporting the development!</p>

<p align="center">
<a href="https://ko-fi.com/mralanbourne" target="_blank">
<img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" height="45" alt="Buy Me a Coffee at ko-fi.com" />
</a>
</p>

<p align="center">
Made with 💙 for the Anime Community.
</p>
