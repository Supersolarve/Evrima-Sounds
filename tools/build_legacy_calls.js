// Builds the Legacy soundboard audio from The Isle Legacy game files.
//
// Usage: node tools/build_legacy_calls.js <Content dir> [ffmpeg path]
//   <Content dir> is the folder that holds TheIsle/Sound/DinoVocals: an uncooked copy of the game,
//   or an FModel "Export Raw Data" of TheIsle/Content (both keep .uasset/.uexp/.ubulk side by side).
//
// For each species it reads the SoundCues, keeps the five player calls (Broadcast, Attract, Threaten,
// Danger, Generic) per growth stage, drops the "distant" versions, mixes layered calls (Core + Breaths + ...)
// the way the cue plays them, and writes audio/legacy/<Species> <Stage> <Type> <n>.mp3 plus manifest.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [contentDir, ffmpeg = 'ffmpeg'] = process.argv.slice(2);
if (!contentDir) {
    console.error('Usage: node tools/build_legacy_calls.js <Content dir> [ffmpeg path]');
    process.exit(1);
}

const vocalsDir = path.join(contentDir, 'TheIsle', 'Sound', 'DinoVocals');
const outDir = path.join(__dirname, '..', 'audio', 'legacy');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-calls-'));

const SKIP_SPECIES = new Set(['Generic', '_Example']);
const SKIP_CUE = /hyper|hypo|hatchling|neuro|primal|magna|_old|test/i;
const DISTANT = /distant|diztant|_far\b|far_|_far_|_dist\b|_dist_|_d$/i;
const LAYER = /(core|breaths?|underlay|fx|attack|power|jaw|bass|sweetener)/i;
const TYPES = [
    ['Broadcast', /broad/i],
    ['Attract', /attract|friend/i],
    ['Threaten', /threat/i],
    ['Danger', /danger/i],
    ['Generic', /calls?|generic|_gen_/i],
];

function strings(file) {
    return fs.readFileSync(file).toString('latin1').match(/[\x20-\x7e]{4,}/g) || [];
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
    });
}

// UE stores the Vorbis stream inline in .uexp or streamed in .ubulk; walk Ogg pages until end-of-stream.
function extractOgg(assetBase) {
    const parts = ['.uexp', '.ubulk'].map(ext => assetBase + ext).filter(f => fs.existsSync(f));
    const buf = Buffer.concat(parts.map(f => fs.readFileSync(f)));
    const start = buf.indexOf('OggS');
    if (start < 0) return null;
    let p = start;
    while (p + 27 <= buf.length && buf.toString('latin1', p, p + 4) === 'OggS') {
        const flags = buf[p + 5], nseg = buf[p + 26];
        let len = 27 + nseg;
        for (let i = 0; i < nseg; i++) len += buf[p + 27 + i];
        p += len;
        if (flags & 4) break;
    }
    return buf.subarray(start, p);
}

function classify(cueRel) {
    const name = path.basename(cueRel);
    const type = TYPES.find(([, re]) => re.test(name));
    if (!type) return null;
    const stage = /juv/i.test(cueRel) ? 'Juvenile' : /(^|[\\/_])sub/i.test(cueRel) ? 'Subadult' : 'Adult';
    return { type: type[0], stage };
}

// Prefer "_New" cues, then non-AI ones, then the one with more variations.
function cueScore(cue) {
    return (/_new/i.test(cue.name) ? 100 : 0) + (/(^|_)ai_/i.test(cue.name) ? 0 : 50) + cue.waves.length;
}

function lastNumber(name) {
    const m = name.match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : 1;
}

// Turn a cue's waves into playable variations: each wave on its own, or matching-numbered layers mixed together.
// Unlabelled waves form the "main" layer (e.g. Veloc_Attract_01 + WA_Veloc_Attract_Breath_01).
// A layer with a single wave (e.g. WA_Allo_ThreatBass) is mixed into every variation.
function variations(waves) {
    const layers = {};
    waves.forEach(w => {
        const m = path.basename(w).match(LAYER);
        const key = m ? m[1].toLowerCase().replace(/s$/, '') : 'main';
        (layers[key] = layers[key] || []).push(w);
    });
    const keys = Object.keys(layers);
    if (keys.length < 2) return waves.map(w => [w]);

    const lead = layers.core ? 'core' : layers.main ? 'main' : keys[0];
    return layers[lead].map(leadWave => {
        const n = lastNumber(path.basename(leadWave));
        return keys.flatMap(k => {
            if (k === lead) return [leadWave];
            const match = layers[k].find(w => lastNumber(path.basename(w)) === n);
            return match ? [match] : layers[k].length === 1 ? layers[k] : [];
        });
    });
}

function encode(layerFiles, outFile) {
    const inputs = layerFiles.flatMap(f => ['-i', f]);
    const filter = layerFiles.length > 1
        ? ['-filter_complex', `amix=inputs=${layerFiles.length}:normalize=0,alimiter=limit=0.95`]
        : [];
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, ...filter,
        '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-q:a', '4', outFile]);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const manifest = {};
const report = [];
let oggCount = 0;

for (const species of fs.readdirSync(vocalsDir).sort()) {
    const speciesDir = path.join(vocalsDir, species);
    if (SKIP_SPECIES.has(species) || !fs.statSync(speciesDir).isDirectory()) continue;

    const chosen = {};
    for (const file of walk(speciesDir).filter(f => f.endsWith('.uasset'))) {
        const s = strings(file);
        if (!s.includes('Default__SoundCue')) continue;
        const rel = path.relative(speciesDir, file).replace(/\.uasset$/, '');
        if (SKIP_CUE.test(rel)) continue;
        const cls = classify(rel);
        if (!cls) continue;

        const waves = [...new Set(s.filter(x => x.startsWith('/Game/') && !x.includes('.') && x.includes('/DinoVocals/') && x !== '/Game/TheIsle/Sound/DinoVocals/' + species + '/' + rel.replace(/\\/g, '/')))]
            .filter(x => !DISTANT.test(path.posix.basename(x)))
            .map(x => path.join(contentDir, ...x.replace(/^\/Game\//, '').split('/')))
            .filter(x => fs.existsSync(x + '.uexp') && !strings(x + '.uasset').includes('Default__SoundCue'));
        if (waves.length === 0) continue;

        const cue = { name: path.basename(rel), rel, waves, ...cls };
        const key = cls.stage + ' ' + cls.type;
        if (!chosen[key] || cueScore(cue) > cueScore(chosen[key])) chosen[key] = cue;
    }

    for (const key of Object.keys(chosen).sort()) {
        const cue = chosen[key];
        const vars = variations(cue.waves);
        vars.forEach((layerWaves, i) => {
            const oggs = layerWaves.map(w => {
                const ogg = extractOgg(w);
                if (!ogg) return null;
                const f = path.join(tmpDir, `${oggCount++}.ogg`);
                fs.writeFileSync(f, ogg);
                return f;
            }).filter(Boolean);
            if (oggs.length === 0) return;
            encode(oggs, path.join(outDir, `${species} ${cue.stage} ${cue.type} ${i + 1}.mp3`));
        });
        manifest[species] = manifest[species] || {};
        manifest[species][cue.stage] = manifest[species][cue.stage] || {};
        manifest[species][cue.stage][cue.type] = vars.length;
        report.push(`${species.padEnd(16)} ${key.padEnd(20)} ${vars.length}x  ${cue.rel}  [${vars.map(v => v.map(w => path.basename(w)).join('+')).join(', ')}]`);
    }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(report.join('\n'));
console.log(`\n${Object.keys(manifest).length} species, ${fs.readdirSync(outDir).filter(f => f.endsWith('.mp3')).length} mp3 files`);
