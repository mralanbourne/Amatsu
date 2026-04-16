//===============
// AMATSU NYAA - SMART QUEUE (WARP EDITION)
//===============
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { SocksProxyAgent } = require("socks-proxy-agent");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60;

const MIRRORS = ["https://nyaa.si", "https://nyaa.iss.one"];

let lastRequestTime = 0;
const DELAY_MS = 1200;

async function fetchWithQueue(url, agent) {
    const now = Date.now();
    const timeToWait = Math.max(0, lastRequestTime + DELAY_MS - now);
    lastRequestTime = now + timeToWait; 
    
    if (timeToWait > 0) {
        await new Promise(res => setTimeout(res, timeToWait));
    }
    
    return axios.get(url, {
        timeout: 8000,
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml, */*"
        },
        httpsAgent: agent
    });
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 2) return [];
    
    const cleanTitle = romajiTitle.replace(/[^\w\s]/gi, " ").replace(/\s+/g, " ").trim();
    const queryKey = cleanTitle.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`\n[NYAA] 🔍 Queue Search via WARP: "${cleanTitle}"`);
    const encodedQuery = encodeURIComponent(cleanTitle);
    const agent = new SocksProxyAgent("socks5h://warp-proxy:9091");

    for (const baseUrl of MIRRORS) {
        try {
            const rssUrl = `${baseUrl}/?page=rss&q=${encodedQuery}&s=seeders&o=desc&c=1_0`;
            const start = Date.now();
            
            const response = await fetchWithQueue(rssUrl, agent);
            const duration = Date.now() - start;
            
            if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                console.log(`[MIRROR INFO] ❌ ${baseUrl} -> CF Block [${duration}ms]`);
                continue;
            }

            console.log(`[MIRROR INFO] ✅ ${baseUrl} -> SUCCESS [${duration}ms]`);
            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
            
            const results = items.map(item => ({
                title: item.title,
                hash: item["nyaa:infoHash"]?.toLowerCase(),
                seeders: parseInt(item["nyaa:seeders"], 10) || 0,
                size: item["nyaa:size"] || "Unknown"
            })).filter(i => i.hash).sort((a, b) => b.seeders - a.seeders);

            searchCache.set(queryKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
            return results;

        } catch (error) {
            const status = error.response ? error.response.status : error.message;
            console.log(`[MIRROR INFO] ❌ ${baseUrl} -> FAIL (${status})`);
        }
    }
    
    console.error(`[NYAA] 💀 All mirrors failed for "${cleanTitle}"`);
    return [];
}

module.exports = { searchNyaaForAnime };
