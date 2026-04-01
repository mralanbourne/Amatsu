//===============
// YOMI PARSING ENGINE
// Centralized logic for extracting episode numbers and matching filenames.
//===============


// Extracts the episode number from a messy torrent filename. Extension list updated to safely strip image-based subs.
function extractEpisodeNumber(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, "")
                        .replace(/\b(?:x|h)26[45]\b/gi, "")
                        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10bit|8bit|10-bit|8-bit)\b/gi, "")
                        .replace(/\[[a-fA-F0-9]{8}\]/g, "")
                        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ");

    const explicitRegex = /(?:ep(?:isode)?\.?\s*|ova\s*|s\d+e)0*(\d+)(?:v\d)?\b/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) return parseInt(explicitMatch[1], 10);

    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:v\d)?(?:$|\s)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    
    const bracketMatch = clean.match(/\[0*(\d+)(?:v\d)?\]|\(0*(\d+)(?:v\d)?\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);

    clean = clean.replace(/[\[\]\(\)\{\}_\-\+~,]/g, " ").trim();
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^0*(\d+)(?:v\d)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}


// Detects if a filename represents a batch range.
function getBatchRange(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, "");
    const batchMatch = clean.match(/\b0*(\d+)\s*(?:-|~|to)\s*0*(\d+)\b/i);
    if (batchMatch) return { start: parseInt(batchMatch[1], 10), end: parseInt(batchMatch[2], 10) };
    return null;
}


// Checks if a given filename matches the requested episode.
function isEpisodeMatch(name, requestedEp) {
    const epNum = parseInt(requestedEp, 10);
    const parts = name.split("/");
    const filename = parts[parts.length - 1];
    
    const extractedEp = extractEpisodeNumber(filename);
    if (extractedEp !== null) {
        return extractedEp === epNum;
    }
    
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) {
        return true;
    }
    
    if (epNum === 1 && extractedEp === null) {
        return !/trailer|promo|menu|teaser|ncop|nced/i.test(filename);
    }
    return false;
}


// Selects the best video file from a list for the requested episode.
function selectBestVideoFile(files, requestedEp) {
    if (!files || files.length === 0) return null;
    
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;

    const matches = videoFiles.filter(f => isEpisodeMatch(f.name || f.path || "", requestedEp));
    if (matches.length > 0) {
        return matches.sort((a, b) => {
            const nameA = (a.name || a.path || "").toLowerCase();
            const nameB = (b.name || b.path || "").toLowerCase();
            const aMkv = nameA.endsWith(".mkv") ? 1 : 0;
            const bMkv = nameB.endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }
    if (videoFiles.length === 1 && parseInt(requestedEp, 10) === 1) return videoFiles[0];
    return videoFiles.length > 0 ? videoFiles[0] : null;
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile };
