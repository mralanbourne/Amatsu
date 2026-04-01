<p align="center">
  <img src="https://raw.githubusercontent.com/mralanbourne/Amatsu/main/static/amatsu_large.png" width="300" alt="Amatsu Logo">
</p>

<h1 align="center">AMATSU: The Heavenly Gateway</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-42a5f5.svg?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Status-Online-success?style=for-the-badge" alt="Status Online">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready">
</p>

<p align="center">
  <strong>The definitive high-performance bridge between Nyaa and Stremio. Access the world's largest library of high-quality Anime via Real-Debrid or Torbox with advanced episode parsing, subtitle injection, and zero server-side tracking.</strong>
</p>

<div align="center">
  <h3>🌐 Community Instance</h3>
  <a href="https://amatsu.your-domain.com">amatsu.your-domain.com</a>
  <br />
  <br />
  <a href="https://amatsu.your-domain.com">
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
> * **Base64 Config:** Your Debrid keys are stored exclusively in your personal Manifest URL using secure Base64 encoding.
> * **Direct Resolution:** Stream links are resolved on-the-fly and redirected directly to your player.
> * **100% Open Source:** Your security is paramount. Verify the code yourself. Everything is public.

### 🌙 Quick Start
1. Open your hosted instance and enter your Real-Debrid and / or Torbox API Key.
2. Choose your catalog preferences (Trending / Top Rated).
3. Click "Install" to add your personalized configuration to Stremio.
4. Use the global Stremio search. Results will appear under the **"Amatsu Search"** catalog.

### ✨ Key Features
* **🧠 Advanced Torrent Parsing:** Automatically strips group tags and resolution info to neatly match episodes and format subtitles.
* **🌊 Universal Subtitle Proxy:** Bypasses Stremio's CORS limitations! Amatsu detects `.ass`, `.srt`, `.vtt`, and `.ssa` files inside torrents, proxies them, and injects them directly into your player.
* **🎯 Universal Fallback Engine:** If AniList fails to find a title, Amatsu automatically tries synonyms, English titles, and truncated names to find your streams on Nyaa.
* **⚡ Hybrid Debrid Support:** Full, seamless integration for both Real-Debrid and Torbox.
* **📦 Built for Co-Hosting:** Specifically configured to run side-by-side with [Yomi](https://github.com/mralanbourne/Yomi) and [Ukiyo](https://github.com/mralanbourne/Ukiyo) on Port 7002.

---

<details>
<summary>💻 <strong>Self-Hosting Instructions (Developers)</strong></summary>

### Hosting your own Gateway
Amatsu is optimized for Oracle ARM (Frankfurt) and VPS environments.

#### 1. Prerequisites
* **Node.js:** v18 or higher.
* **Docker & Docker-Compose** (Recommended).

#### 2. Deployment (Docker Compose)
1. **Clone the Repo:**
```bash
git clone [https://github.com/mralanbourne/Amatsu.git](https://github.com/mralanbourne/Amatsu.git)
cd Amatsu

    Build and Run:

Bash

docker-compose up -d

Amatsu will start on Port 7002.

Environment Variables:

    BASE_URL: REQUIRED. Your public domain (e.g., https://www.google.com/search?q=https://amatsu.yourdomain.com).

    PORT: Optional. Defaults to 7002.

</details>

<p align="center">
Made with 💙 for the Anime Community.
</p>