//===============
// AMATSU GATEWAY - SERVER CORE
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

// API status endpoint
app.get("/health", (req, res) => res.status(200).json({ "status": "alive" }));

//===============
// NYAA STATUS CHECK
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
        nyaaCache = { "status": "online", "timestamp": now };
        res.json({ "status": "online" });
    }
});

app.get("/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

//===============
// BULLETPROOF SUBTITLE PROXY
//===============
app.get("/sub/:provider/:apiKey/:hash/:fileId", async (req, res) => {
    const { provider, apiKey, hash, fileId } = req.params;
    let clientAborted = false;
    
    req.on("close", () => { clientAborted = true; });
    
    try {
        let downloadUrl = null;
        let fileName = req.query.filename || "sub.srt";
        
        if (provider === "realdebrid") {
            let list = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250", { "headers": { "Authorization": "Bearer " + apiKey } });
            let torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
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
                    if (targetFile.selected === 0) return res.status(404).send("Subtitle not selected");

                    fileName = targetFile.path;
                    let targetLink = null;
                    let linkCounter = 0;
                    for (let i = 0; i < info.data.files.length; i++) {
                        if (i === fileIdx) { targetLink = info.data.links[linkCounter]; break; }
                        if (info.data.files[i].selected === 1) linkCounter++;
                    }

                    if (targetLink) {
                        const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", new URLSearchParams({ "link": targetLink }), { "headers": { "Authorization": "Bearer " + apiKey } });
                        downloadUrl = unrestrict.data.download;
                    }
                }
            }
        } else if (provider === "torbox") {
            let dlRes = null;
            try {
                dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&hash=" + hash + "&file_id=" + fileId);
            } catch (err) {
                await new Promise(resolve => setTimeout(resolve, 2500));
                dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&hash=" + hash + "&file_id=" + fileId);
            }
            if (dlRes && dlRes.data && dlRes.data.data) downloadUrl = dlRes.data.data;
        }
        
        if (!downloadUrl) return res.status(404).send("Subtitle not found");
        
        const subResponse = await axios.get(downloadUrl, { "responseType": "stream", "timeout": 10000 });
        if (clientAborted) { if (subResponse.data?.destroy) subResponse.data.destroy(); return; }

        const ext = fileName.split(".").pop().toLowerCase();
        let finalMime = subResponse.headers["content-type"];
        
        if (!finalMime || finalMime.includes("octet-stream") || finalMime.includes("plain")) {
            if (ext === "vtt") finalMime = "text/vtt";
            else if (ext === "ass" || ext === "ssa") finalMime = "text/x-ssa";
            else if (ext === "srt") finalMime = "application/x-subrip";
            else finalMime = "text/plain";
        }
        
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", finalMime);
        res.setHeader("Cache-Control", "public, max-age=86400");
        
        subResponse.data.on("error", () => res.end());
        req.on("close", () => { if (subResponse.data?.destroy) subResponse.data.destroy(); });
        subResponse.data.pipe(res);
        
    } catch (e) { 
        console.error("[Sub Proxy Error]", e.message);
        res.status(500).send("Error fetching subtitle data"); 
    }
});
    
function serveLoadingVideo(req, res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(BASE_URL + "/waiting.mp4");
}

function serveArchiveVideo(req, res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(BASE_URL + "/archive.mp4");
}

//===============
// STREAM RESOLVER
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
                const add = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", new URLSearchParams({ "magnet": magnet }), { "headers": { "Authorization": "Bearer " + apiKey } });
                torrent = { "id": add.data.id };
            }
            
            let info = await axios.get("https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } });
            if (["magnet_error", "error", "virus", "dead"].includes(info.data.status)) {
                await axios.delete("https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } }).catch(() => null);
                return res.status(404).send("Torrent is dead.");
            }
            
            if (info.data.status !== "downloaded") {
                if (info.data.status === "waiting_files_selection") {
                    const selectedIds = info.data.files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|m2ts|mov|ass|srt|ssa|vtt)$/.test((f.path || "").toLowerCase())).map(f => f.id);
                    await axios.post("https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrent.id, "files=" + (selectedIds.length > 0 ? selectedIds.join(",") : "all"), { 
                        "headers": { "Authorization": "Bearer " + apiKey, "Content-Type": "application/x-www-form-urlencoded" } 
                    });
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    info = await axios.get("https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } });
                }
                if (info.data.status !== "downloaded") return serveLoadingVideo(req, res);
            }
            
            const isBatch = /batch|complete|all\s+episodes/i.test(info.data.filename || "");
            const bestFileFresh = selectBestVideoFile(info.data.files, requestedEp, 1, !isBatch);
            
            if (!bestFileFresh) return serveArchiveVideo(req, res);
            if (bestFileFresh.selected === 0) {
                await axios.delete("https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id, { "headers": { "Authorization": "Bearer " + apiKey } }).catch(() => null);
                return res.redirect(req.originalUrl);
            }
            
            const targetFileIndex = info.data.files.findIndex(f => f.id === bestFileFresh.id);
            let targetLink = info.data.links[0]; 
            if (targetFileIndex !== -1) {
                let linkCounter = 0;
                for (let i = 0; i < info.data.files.length; i++) {
                    if (i === targetFileIndex) { targetLink = info.data.links[linkCounter]; break; }
                    if (info.data.files[i].selected === 1) linkCounter++;
                }
            }
            if (!targetLink) return serveLoadingVideo(req, res);

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
                } catch (e) { return serveLoadingVideo(req, res); }
                return serveLoadingVideo(req, res);
            }
            
            if (["error", "failed", "dead", "deleted"].includes(torrent.download_state)) return res.status(404).send("Torrent is dead.");
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") return serveLoadingVideo(req, res);
            
            const isBatch = /batch|complete|all\s+episodes/i.test(torrent.name || "");
            const bestFile = selectBestVideoFile(torrent.files, requestedEp, 1, !isBatch);
            
            if (!bestFile) return serveArchiveVideo(req, res);
            const dl = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl?token=" + apiKey + "&torrent_id=" + torrent.id + "&file_id=" + bestFile.id);
            return res.redirect(dl.data.data);
        }
    } catch (e) { 
        console.error("[Resolve Error] Core resolution failure: " + e.message);
        return serveLoadingVideo(req, res); 
    }
});

app.use("/", getRouter(addonInterface));
app.listen(port, "0.0.0.0", () => console.log("AMATSU ONLINE | PORT " + port));
