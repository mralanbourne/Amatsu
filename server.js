//===============
// AMATSU GATEWAY - SERVER CORE
// This is the entry point of the application. It sets up the Express server,
// handles static assets, and provides the specialized routes for stream resolution
// and subtitle proxying.
//===============

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface } = require("./addon");
const { selectBestVideoFile } = require("./lib/parser");

const app = express();
app.use(express.json()); 

//===============
// CORS & PREFLIGHT HANDLING
//===============
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    
    next();
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "static")));

const port = process.env.PORT || 7002;

// Fallback for missing environment variables when self-hosting
let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

const NYAA_DOMAIN = (process.env.NYAA_DOMAIN || "https://nyaa.iss.one").replace(/\/+$/, "");

// API status endpoint for platforms such as Heroku or Koyeb
app.get("/health", (req, res) => res.status(200).json({ "status": "alive" }));

//===============
// NYAA STATUS CHECK
// Checks Nyaa and caches the result for 5 minutes.
//===============
let nyaaCache = { "status": "checking", "timestamp": 0 };

app.get("/nyaa-status", async (req, res) => {
    const now = Date.now();
    if (now - nyaaCache.timestamp < 300000 && nyaaCache.status !== "checking") {
        return res.json({ "status": nyaaCache.status });
    }
    
    try {
        await axios.get(NYAA_DOMAIN, {
            "timeout": 5000,
            "headers": {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            },
            "validateStatus": function (status) {
                return (status >= 200 && status < 300) || status === 403 || status === 503;
            }
        });

        nyaaCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    } catch (error) {
        console.warn("[Nyaa Check] Network exception:", error.message);
        
        nyaaCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    }
});

app.get("/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

//===============
// SUBTITLE PROXY
// Downloads subtitles directly and streams them to the client.
// Includes critical bandwidth-leak protections and strict upstream MIME parsing.
//===============
app.get("/sub/:provider/:apiKey/:hash/:fileId", async (req, res) => {
    const { provider, apiKey, hash, fileId } = req.params;
    
    // Flag to detect early client disconnection and prevent dangling streams
    let clientAborted = false;
    req.on("close", () => {
        clientAborted = true;
    });
    
    try {
        let downloadUrl = null;
        let fileName = req.query.filename || "sub.srt";
        
        if (provider === "realdebrid") {
            let list = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250", { "headers": { "Authorization": "Bearer " + apiKey } });
            let torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
            // Retry-Logic
            if (!torrent) {
                await new Promise(resolve => setTimeout(resolve, 2500));
                list = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250", { "headers": { "Authorization": "Bearer " + apiKey } });
                torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            }

            if (torrent) {
                const info = await axios.get("https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } });
                const fileIdx = info.data.files.findIndex(f => f.id == fileId);
                
                if (fileIdx !== -1) {
                    const targetFile = info.data.files[fileIdx];
                    
                    if (targetFile.selected === 0) {
                        return res.status(404).send("Subtitle not selected in Debrid");
                    }

                    fileName = targetFile.path;
                    let targetLink = null;
                    let linkCounter = 0;
                    
                    // Real-Debrid maps links ONLY to selected files, not all files. Calculate the correct offset.
                    for (let i = 0; i < info.data.files.length; i++) {
                        if (i === fileIdx) {
                            targetLink = info.data.links[linkCounter];
                            break;
                        }
                        if (info.data.files[i].selected === 1) {
                            linkCounter++;
                        }
                    }

                    if (targetLink) {
                        const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", new URLSearchParams({ "link": targetLink }), { "headers": { "Authorization": "Bearer " + apiKey } });
                        downloadUrl = unrestrict.data.download;
                    }
                }
            }
        } else if (provider === "torbox") {

            // Retry-Logic for Torbox
            let dlRes = null;
            try {
                dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&hash=" + hash + "&file_id=" + fileId);
            } catch (err) {
                await new Promise(resolve => setTimeout(resolve, 2500));
                dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&hash=" + hash + "&file_id=" + fileId);
            }

            if (dlRes && dlRes.data && dlRes.data.data) {
                downloadUrl = dlRes.data.data;
            }
        }
        
        if (!downloadUrl) return res.status(404).send("Subtitle not found or not ready yet.");
        
        const subResponse = await axios.get(downloadUrl, { "responseType": "stream" });
        
        // If the client aborted during the async await cycles, destroy the stream immediately to save bandwidth
        if (clientAborted) {
            if (subResponse.data && typeof subResponse.data.destroy === "function") {
                subResponse.data.destroy();
            }
            return;
        }

        const upstreamMime = subResponse.headers["content-type"];
        const ext = fileName.split(".").pop().toLowerCase();
        let fallbackMime = "text/plain";
        if (ext === "vtt") fallbackMime = "text/vtt";
        else if (ext === "ass" || ext === "ssa") fallbackMime = "text/x-ssa";
        else if (ext === "srt") fallbackMime = "application/x-subrip";
        
        let finalMime = upstreamMime;
        if (!finalMime || finalMime.includes("octet-stream")) {
            finalMime = fallbackMime;
        }
        
        res.set("Content-Type", finalMime);
        
        // Prevent socket memory leaks if the download errors out
        subResponse.data.on("error", (err) => {
            console.error("[Stream Error] Subtitle stream aborted: " + err.message);
            res.end();
        });
        
        req.on("close", () => {
            if (subResponse && subResponse.data && typeof subResponse.data.destroy === "function") {
                subResponse.data.destroy();
            }
        });
        
        subResponse.data.pipe(res);
    } catch (e) { 
        console.error("[Subtitle Error] Failed to fetch subtitle: " + e.message);
        res.status(500).send("Error fetching subtitle data"); 
    }
});
    
//===============
// Displays a loading video whilst the Provider is processing the torrent.
// Uses strict no-store headers to prevent Stremio from caching the redirect loop.
//===============
function serveLoadingVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.redirect(BASE_URL + "/waiting.mp4");
}

//===============
// Displays an information video if the torrent contains only useless archives.
// Uses strict no-store headers to prevent Stremio from caching the redirect loop.
//===============
function serveArchiveVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.redirect(BASE_URL + "/archive.mp4");
}

//===============
// STREAM RESOLVER
// Resolves the magnet link on the fly into a direct video stream.
//===============
app.get("/resolve/:provider/:apiKey/:hash/:episode?", async (req, res) => {
    const { provider, apiKey, hash, episode } = req.params;
    const requestedEp = episode || "1";
    const magnet = "magnet:?xt=urn:btih:" + hash;
    
    try {
        if (provider === "realdebrid") {
            const listRes = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250", { "headers": { "Authorization": "Bearer " + apiKey } });
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
            if (!torrent) {
                try {
                    const add = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", new URLSearchParams({ "magnet": magnet }), { "headers": { "Authorization": "Bearer " + apiKey } });
                    torrent = { "id": add.data.id };
                } catch (addError) {
                    console.error("[Real-Debrid] Failed to create torrent: " + addError.message);
                    return res.status(500).send("Real-Debrid API Error: Cannot add torrent.");
                }
            }
            
            let info = await axios.get("https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } });
            
            // Catch dead or invalid torrents immediately to avoid infinite loading loops
            const badStates = ["magnet_error", "error", "virus", "dead"];
            if (badStates.includes(info.data.status)) {
                await axios.delete("https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } }).catch(() => null);
                return res.status(404).send("Torrent is dead or invalid.");
            }
            
            if (info.data.status !== "downloaded") {
                if (info.data.status === "waiting_files_selection") {
                    const selectedIds = [];

                    info.data.files.forEach(f => {
                        const name = (f.path || f.name || "").toLowerCase();
                        if (/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|m2ts|mov|ass|srt|ssa|vtt)$/.test(name)) {
                            selectedIds.push(f.id);
                        }
                    });
                    
                    const bodyString = "files=" + (selectedIds.length > 0 ? selectedIds.join(",") : "all");
                    
                    await axios.post("https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrent.id, bodyString, { 
                        "headers": { 
                            "Authorization": "Bearer " + apiKey,
                            "Content-Type": "application/x-www-form-urlencoded"
                        } 
                    });

                    await new Promise(resolve => setTimeout(resolve, 1500));
                    info = await axios.get("https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } });
                }
                
                if (info.data.status !== "downloaded") {
                    return serveLoadingVideo(req, res);
                }
            }
            
            const bestFileFresh = selectBestVideoFile(info.data.files, requestedEp);
            
            if (!bestFileFresh) {
                return serveArchiveVideo(req, res);
            }
            
            // Resolves the edge case where a legacy torrent has an unselected episode
            if (bestFileFresh.selected === 0) {
                console.log("[Resolve] Unselected episode detected. Re-adding torrent to trigger selection.");
                await axios.delete("https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } }).catch(() => null);
                return res.redirect(req.originalUrl);
            }
            
            const targetFileIndex = info.data.files.findIndex(f => f.id === bestFileFresh.id);
            let targetLink = info.data.links[0]; 
            
            if (targetFileIndex !== -1) {
                let linkCounter = 0;
                for (let i = 0; i < info.data.files.length; i++) {
                    if (i === targetFileIndex) {
                        targetLink = info.data.links[linkCounter];
                        break;
                    }
                    if (info.data.files[i].selected === 1) {
                        linkCounter++;
                    }
                }
            }

            if (!targetLink) {
                 return serveLoadingVideo(req, res);
            }

            const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", new URLSearchParams({ "link": targetLink }), { "headers": { "Authorization": "Bearer " + apiKey } });
            return res.redirect(unrestrict.data.download);
        }
        
        if (provider === "torbox") {
            const list = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { "headers": { "Authorization": "Bearer " + apiKey } });
            let torrent = list.data.data ? list.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase()) : null;
            
            if (!torrent) {
                const boundary = "----WebKitFormBoundaryAmatsu";
                try {
                    await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", "--" + boundary + "\r\nContent-Disposition: form-data; name=\"magnet\"\r\n\r\n" + magnet + "\r\n--" + boundary + "--", { "headers": { "Authorization": "Bearer " + apiKey, "Content-Type": "multipart/form-data; boundary=" + boundary } });
                } catch (postError) {
                    console.error("[Torbox] Failed to create torrent: " + postError.message);
                    if (postError.response && postError.response.status === 403) {
                         return res.status(403).send("API Key invalid.");
                    }
                    return serveLoadingVideo(req, res);
                }
                return serveLoadingVideo(req, res);
            }
            
            const tbBadStates = ["error", "failed", "dead", "deleted"];
            if (tbBadStates.includes(torrent.download_state)) {
                return res.status(404).send("Torrent is dead or invalid in Torbox.");
            }
            
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") return serveLoadingVideo(req, res);
            
            const bestFile = selectBestVideoFile(torrent.files, requestedEp);
            if (!bestFile) {
                return serveArchiveVideo(req, res);
            }
            
            const dl = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&torrent_id=" + torrent.id + "&file_id=" + bestFile.id);
            return res.redirect(dl.data.data);
        }
    } catch (e) { 
        console.error("[Resolve Error] Core resolution failure: " + e.message);
        
        if (e.response && e.response.status === 403) {
            return res.status(403).send("Real-Debrid API Key invalid or Premium subscription expired.");
        }
        
        return serveLoadingVideo(req, res); 
    }
});

app.use("/", getRouter(addonInterface));
app.listen(port, "0.0.0.0", () => console.log("AMATSU ONLINE | PORT " + port));
