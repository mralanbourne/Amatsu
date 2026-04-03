//===============
// YOMI PARSING ENGINE
// Centralized logic for extracting episode numbers and matching filenames.
//===============

function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, "")
                        .replace(/\b(?:x|h)26[45]\b/gi, "")
                        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10bit|8bit|10-bit|8-bit)\b/gi, "")
                        .replace(/\[[a-fA-F0-9]{8}\]/g, "")
                        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ");

    //===============
    // Regex has been extended to capture season numbers (SxxEyy).
    // If a season number appears in the filename, the system checks whether it matches the search query.
    //===============
    const explicitRegex = /(?:ep(?:isode)?\.?\s*|ova\s*|s(\d+)e)0*(\d+)(?:v\d)?\b/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) {
        if (explicitMatch[1] !== undefined) {
            const fileSeason = parseInt(explicitMatch[1], 10);
            if (fileSeason !== expectedSeason) return null;
            return parseInt(explicitMatch[2], 10);
        }
        return parseInt(explicitMatch[2], 10);
    }

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

function getBatchRange(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, "");
    const batchMatch = clean.match(/\b0*(\d+)\s*(?:-|~|to)\s*0*(\d+)\b/i);
    if (batchMatch) return { start: parseInt(batchMatch[1], 10), end: parseInt(batchMatch[2], 10) };
    return null;
}

function isEpisodeMatch(name, requestedEp, expectedSeason = 1) {
    const epNum = parseInt(requestedEp, 10);
    const parts = name.split("/");
    const filename = parts[parts.length - 1];
    
    const extractedEp = extractEpisodeNumber(filename, expectedSeason);
    if (extractedEp !== null) {
        return extractedEp === epNum;
    }
    
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) {
        return true;
    }
    
    if (epNum === 1 && extractedEp === null) {
        //===============
        // Now checks the full path (name) instead of just the filename.
        // Blocks folders/files with names like "Extras," "Interview," or "Greeting
        //===============
        return !/trailer|promo|menu|teaser|ncop|nced|extra|interview|greeting|geeting|special|credit|making/i.test(name);
    }
    return false;
}

function selectBestVideoFile(files, requestedEp, expectedSeason = 1) {
    if (!files || files.length === 0) return null;
    
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;

    const matches = videoFiles.filter(f => isEpisodeMatch(f.name || f.path || "", requestedEp, expectedSeason));
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

    if (videoFiles.length === 1 && parseInt(requestedEp, 10) === 1) {
        const extEp = extractEpisodeNumber(videoFiles[0].name || videoFiles[0].path || "", expectedSeason);
        if (extEp === null || extEp === 1) return videoFiles[0];
    }
    
    return null;
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile };
