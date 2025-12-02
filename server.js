const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(__dirname, 'temp');
[DOWNLOADS_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'online',
        ai: process.env.GROQ_API_KEY ? 'enabled' : 'disabled'
    });
});

// Video Info
app.post('/api/video-info', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL fehlt' });

    exec(`yt-dlp --dump-json --no-warnings "${url}"`, { timeout: 60000 }, (error, stdout) => {
        if (error) return res.status(500).json({ error: 'Video nicht gefunden' });
        
        try {
            const info = JSON.parse(stdout);
            res.json({
                success: true,
                title: info.title,
                duration: info.duration,
                thumbnail: info.thumbnail,
                author: info.uploader || info.channel
            });
        } catch (e) {
            res.status(500).json({ error: 'Parsing-Fehler' });
        }
    });
});

// KI Video-Analyse
app.post('/api/analyze-video', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL fehlt' });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'KI nicht konfiguriert' });

    const audioFile = path.join(TEMP_DIR, `audio-${Date.now()}.mp3`);
    
    try {
        console.log('🎵 Extrahiere Audio...');
        await new Promise((resolve, reject) => {
            exec(`yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioFile}" --download-sections "*0:00-10:00" "${url}"`, 
                { timeout: 300000 }, (error) => error ? reject(error) : resolve());
        });

        console.log('🎤 Transkribiere...');
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioFile),
            model: 'whisper-large-v3',
            response_format: 'verbose_json',
            timestamp_granularities: ['segment']
        });

        console.log('🧠 Analysiere mit KI...');
        const segments = transcription.segments || [];
        const segmentText = segments.map(s => `[${Math.floor(s.start)}s]: ${s.text}`).join('\n');
        
        const completion = await groq.chat.completions.create({
            messages: [{ 
                role: 'user', 
                content: `Analysiere dieses Video-Transkript und finde die 3-5 besten Clip-Momente.

Transkript:
${segmentText}

Antworte NUR als JSON-Array:
[{"start": 0, "end": 30, "title": "Clip Titel", "reason": "Warum interessant", "score": 95}]

Regeln: start/end in Sekunden, Clips 15-60 Sek lang, score 1-100`
            }],
            model: 'llama-3.1-70b-versatile',
            temperature: 0.3
        });

        fs.unlinkSync(audioFile);

        let highlights = [];
        const jsonMatch = completion.choices[0]?.message?.content?.match(/\[[\s\S]*\]/);
        if (jsonMatch) highlights = JSON.parse(jsonMatch[0]);

        res.json({ success: true, transcription: transcription.text, highlights });
    } catch (error) {
        console.error('Fehler:', error);
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
        res.status(500).json({ error: error.message });
    }
});

// Clip erstellen
app.post('/api/create-clip', (req, res) => {
    const { url, startTime, duration, clipName } = req.body;
    if (!url || startTime === undefined || !duration) {
        return res.status(400).json({ error: 'Parameter fehlen' });
    }

    const safeName = (clipName || 'clip').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const outputFile = `${safeName}-${Date.now()}.mp4`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFile);

    console.log(`✂️ Erstelle Clip: ${safeName}`);

    exec(`yt-dlp -f "best[height<=720]/best" -o - "${url}" | ffmpeg -ss ${startTime} -i pipe:0 -t ${duration} -c:v libx264 -preset ultrafast -c:a aac -y "${outputPath}"`,
        { timeout: 300000, maxBuffer: 200 * 1024 * 1024 },
        (error) => {
            if (error) {
                console.error('Clip-Fehler:', error);
                return res.status(500).json({ error: 'Clip-Erstellung fehlgeschlagen' });
            }
            
            if (fs.existsSync(outputPath)) {
                console.log(`✅ Clip erstellt: ${outputFile}`);
                res.json({ success: true, downloadUrl: `/downloads/${outputFile}`, filename: outputFile });
            } else {
                res.status(500).json({ error: 'Datei nicht erstellt' });
            }
        }
    );
});

// Cleanup alle 30 Min
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    [DOWNLOADS_DIR, TEMP_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => {
            const p = path.join(dir, file);
            try { if (fs.statSync(p).mtimeMs < oneHourAgo) fs.unlinkSync(p); } catch {}
        });
    });
}, 1800000);

app.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(`🚀 Server läuft auf Port ${PORT}`);
    console.log(`🤖 KI: ${process.env.GROQ_API_KEY ? 'Aktiviert' : 'Deaktiviert'}`);
    console.log('=========================================');
});
