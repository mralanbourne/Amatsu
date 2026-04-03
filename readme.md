<p align="center">
  <img src="https://raw.githubusercontent.com/mralanbourne/Amatsu/main/static/amatsu_large.png" width="300" alt="Amatsu Logo">
</p>

<h1 align="center">AMATSU: Your Heavenly Gateway</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-6.7.0-42a5f5.svg?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Status-Online-success?style=for-the-badge" alt="Status Online">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready">
</p>

<p align="center">
  <strong>The definitive high-performance bridge between Nyaa.si and Stremio. Access the world's largest library of high-quality Anime via Real-Debrid or Torbox with advanced episode parsing, multi-language sorting, subtitle injection, and zero server-side tracking.</strong>
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
> Nyaa is the gold standard for anime releases, but naming conventions vary wildly. Amatsu uses no backend database to store results, so to use this addon effectively, you **need** to know these 5 quirks:
> 
> 1. 🧠 **Always check the filename:** Amatsu features an aggressive multi-stage parsing engine to find the exact episode you clicked on (even inside huge season batches). However, it might guess wrong. **Always look at the `🎯 File` description** in the stream list to ensure you are selecting the right file!
> 2. 🖼️ **The "Blue Posters" (Working as intended):** During a global search, obscure Nyaa results will appear as blue text-only posters to keep the search lightning fast. **This is not a bug!** The real AniList poster, description, and episode count are fetched the moment you click on the title.
> 3. 🎭 **Mismatched Metadata:** Because the addon matches messy Nyaa titles against strict databases like AniList, it will sometimes guess wrong and display the wrong poster. **Don't panic!** The actual video streams are fetched directly from Nyaa based on the raw title, so the content remains correct.
> 4. 👻 **Dynamic Episode Discovery:** If metadata APIs don't know how many episodes a series has (common for OVAs or new releases), Amatsu scans Nyaa titles to detect the actual episode count dynamically.
> 5. 🎬 **The "Loading" Video (Uncached Torrents):** If you click an uncached stream (`☁️ DL`), Stremio will start playing a looping "Waiting/Loading" video. **This is not an error!** It means Amatsu sent the torrent to your Debrid cloud. Wait a bit, back out, and click again to see the live progress (e.g., `[⏳ 45%]`).

> [!IMPORTANT]
> ### 🔒 Privacy & Zero-Knowledge Security
> * Amatsu is built on a **Stateless Architecture**. Unlike other addons, your sensitive data never touches a database.
> * **Base64 Config:** Your Debrid keys and Language preferences are stored exclusively in your personal Manifest URL using secure Base64 encoding.
> * **Direct Resolution:** Stream links are resolved on-the-fly and redirected directly to your player.
> * **100% Open Source:** Your security is paramount. Verify the code yourself. Everything is public.

### 🌙 Quick Start
1. Open the [Community Instance](https://amatsu.onrender.com/) and enter your Real-Debrid and / or Torbox API Key.
2. Select your **Preferred Languages** (e.g., ENG, GER, FRE) from the setup grid.
3. Choose your catalog preferences (Trending / Top Rated).
4. Click "Install" to add your personalized configuration to Stremio.
5. Use the global Stremio search. Results will natively appear under the **"Amatsu Search - Series"** and **"Amatsu Search - Movies"** catalogs.

### ✨ Key Features
* **🌍 Multi-Language Priority Sorter:** Tailor your experience! Select your preferred audio and subtitle languages during setup, and Amatsu's engine will dynamically evaluate torrent tags, pushing your desired languages to the very top of the stream list.
* **🎬 Cinematic Catalog Segregation:** Amatsu strictly identifies release formats, ensuring Anime Movies do not bleed into TV Series rows during global searches, maintaining Stremio's native UI integrity.
* **🧠 Dual-Database Intelligence (AniList + MAL):** Amatsu scrapes AniList for high-quality metadata. If an obscure release is missing, it automatically falls back to MyAnimeList (Jikan API) to guarantee populated posters and synopsis data.
* **🌊 Universal Subtitle Proxy:** Bypasses Stremio's CORS limitations! Amatsu detects `.ass`, `.srt`, `.vtt`, and `.ssa` files inside torrents, proxies them, and injects them directly into your player.
* **🎯 Universal Fallback Engine:** If AniList fails to find a title directly, Amatsu automatically searches synonyms, English titles, and intelligently truncated Light Novel names to find your streams on Nyaa.
* **⚡ Hybrid Debrid Support:** Full, seamless integration for both Real-Debrid and Torbox.

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

```git clone https://github.com/mralanbourne/Amatsu.git```<br />
```cd Amatsu```

2. **Build and Run:**

```docker-compose up -d```

Amatsu will start on Port 7002.

**Environment Variables:**
* `BASE_URL`: **REQUIRED**.<br /> Your public domain (e.g. `https://amatsu.yourdomain.com`).<br /> Amatsu requires this to correctly construct the Subtitle-Proxy and Stream-Resolver links.<br />
* `PORT`: Optional. Defaults to 7002.

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
