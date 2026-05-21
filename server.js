const express = require('express');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ElevenLabs TTS — saves MP3 locally and serves it ──────────
async function generateVoice(text, apiKey) {
  try {
    const voiceId = '29vD33N1CtxCmqQRPOHJ'; // Adam voice
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.slice(0, 120),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    });
    if (!r.ok) { console.log(`  ElevenLabs ${r.status}: ${await r.text()}`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    // Save to public folder so Creatomate can download it
    const fname = `voice_${Date.now()}.mp3`;
    const fpath = path.join(__dirname, 'public', 'imgs', fname);
    require('fs').writeFileSync(fpath, buf);
    const host = (process.env.SERVER_HOST || `http://localhost:${PORT}`).replace(/\/$/, '');
    const url = `${host}/imgs/${fname}`;
    console.log(`  Voice generated: ${url}`);
    return url;
  } catch (e) { console.log(`  Voice error: ${e.message}`); return null; }
}


function parseDuration(str) {
  if (!str) return 6;
  const s = String(str).toLowerCase();
  const m  = s.match(/(\d+\.?\d*)\s*min/); if (m)  return Math.min(Math.round(parseFloat(m[1])*60),30);
  const sc = s.match(/(\d+\.?\d*)\s*(sec|second|s)/); if (sc) return Math.min(Math.max(Math.round(parseFloat(sc[1])),5),30);
  const n  = s.match(/(\d+\.?\d*)/); if (n) return Math.min(Math.max(Math.round(parseFloat(n[1])),5),30);
  return 6;
}

// ── Groq ───────────────────────────────────────────────────────
async function callGroq(sys, user, key) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', temperature: 0.8, max_tokens: 3000,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error(`Groq: ${await r.text()}`);
  return (await r.json()).choices?.[0]?.message?.content || '';
}

// ── Pexels video search ────────────────────────────────────────
async function searchPexels(query, key) {
  try {
    const r = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`,
      { headers: { Authorization: key } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.videos?.length) return null;
    const v = d.videos[Math.floor(Math.random() * Math.min(5, d.videos.length))];
    const f = v.video_files?.find(f => f.quality === 'hd' && f.width >= 1280)
           || v.video_files?.find(f => f.quality === 'hd')
           || v.video_files?.[0];
    console.log(`  Pexels "${query.slice(0,30)}" -> ${f?.link ? 'OK' : 'MISS'}`);
    return f?.link || null;
  } catch (e) { console.log(`  Pexels err: ${e.message}`); return null; }
}

function sceneQuery(scene) {
  const t = ((scene.description||'')+(scene.narration||'')+(scene.title||'')).toLowerCase();
  if (t.match(/fight|punch|kick|combat|martial/)) return 'martial arts fight action';
  if (t.match(/explos|blast|fire|burn/))          return 'explosion fire cinematic';
  if (t.match(/car|chase|driv|speed|race/))       return 'car speed highway cinematic';
  if (t.match(/city|urban|street|night/))          return 'city night cinematic';
  if (t.match(/hero|walk|enter|arrive/))           return 'hero walking cinematic';
  if (t.match(/villain|evil|dark|shadow/))         return 'dark mysterious cinematic';
  if (t.match(/crowd|stadium|cheer/))              return 'crowd stadium cinematic';
  if (t.match(/run|sprint|escap/))                 return 'running action cinematic';
  if (t.match(/gun|shoot|weapon/))                 return 'action thriller dark';
  if (t.match(/mountain|landscape|sky|epic/))      return 'epic landscape drone';
  if (t.match(/rain|storm/))                       return 'rain storm dramatic';
  const words = t.replace(/[^\w\s]/g,'').split(' ').filter(w=>w.length>4).slice(0,2);
  return (words.join(' ')||'cinematic action')+' cinematic';
}

// ── /api/generate ──────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { prompt, style, duration, aspectRatio } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  const key = process.env.GROQ_API_KEY;
  if (!key)   return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const sys = `You are a Hollywood trailer director. Return ONLY raw JSON, no markdown, no backticks.
Invent a FICTIONAL actor (NOT any real celebrity).
Scene descriptions must be vivid and action-packed.
Narration = short punchy trailer voiceover max 2 sentences.

Return ONLY this JSON:
{
  "title": "string",
  "duration": "string",
  "style": "string",
  "synopsis": "string",
  "actor": {
    "name": "fictional name e.g. Arjun Verma",
    "appearance": "detailed look"
  },
  "scenes": [
    {
      "id": 1,
      "title": "string",
      "duration": "8 seconds",
      "description": "vivid visual scene for stock footage",
      "narration": "punchy 1-2 sentence voiceover",
      "actorAction": "what actor does",
      "mood": "intense",
      "cameraWork": "close up",
      "colorPalette": ["#111111"],
      "sfx": "string",
      "transition": "fade"
    }
  ],
  "productionNotes": { "lighting": "string", "music": "dramatic orchestral", "colorGrading": "dark teal orange", "targetAudience": "string" }
}`;

  try {
    const text = await callGroq(sys,
      `Create a ${duration||'60-second'} ${style||'cinematic'} action trailer for: "${prompt}". Generate 5 scenes.`, key);
    const video = JSON.parse(text.replace(/```json|```/g,'').trim());
    res.json({ success: true, video });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /api/refine-scene ──────────────────────────────────────────
app.post('/api/refine-scene', async (req, res) => {
  const { scene, instruction } = req.body;
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  try {
    const text = await callGroq('Return ONLY raw JSON for refined scene. No markdown.',
      `Refine: "${instruction}"\n\n${JSON.stringify(scene,null,2)}`, key);
    res.json({ success: true, scene: JSON.parse(text.replace(/```json|```/g,'').trim()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /api/images-to-video ───────────────────────────────────────
app.post('/api/images-to-video', upload.array('images', 10), async (req, res) => {
  const cmKey = process.env.CREATOMATE_API_KEY;
  if (!cmKey) return res.status(500).json({ error: 'CREATOMATE_API_KEY not set' });

  try {
    const files     = req.files || [];
    const title     = req.body.title     || 'My Video';
    const duration  = parseInt(req.body.duration) || 5;
    const transition = req.body.transition || 'fade';
    const music     = req.body.music     || 'cinematic';

    if (files.length === 0) return res.status(400).json({ error: 'No images uploaded' });

    console.log(`\nImages-to-video: ${files.length} images, ${duration}s each, transition: ${transition}`);

    const MUSIC_URLS = {
      cinematic: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      upbeat:    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
      calm:      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
      none:      null
    };

    const elements = [];
    let time = 0;

    // Title card (3s black background + title text)
    elements.push({
      type: 'video', track: 1, time: 0, duration: 3,
      source: 'https://videos.pexels.com/video-files/3571264/3571264-hd_1920_1080_30fps.mp4',
      volume: 0, fit: 'cover',
      width: '100%', height: '100%',
      x: '50%', y: '50%',
      x_alignment: '50%', y_alignment: '50%'
    });
    elements.push({
      type: 'text', track: 2, time: 0.3, duration: 2.7,
      text: title.toUpperCase(),
      font_family: 'Montserrat', font_weight: '900', font_size: '9 vmin',
      fill_color: '#FFD700', shadow_color: 'rgba(0,0,0,0.9)', shadow_blur: '3 vmin',
      x_alignment: '50%', y_alignment: '50%', width: '85%',
      animations: [
        { time: 0, duration: 0.8, type: 'fade', fade: 'in', easing: 'ease-in-out' },
        { time: 2, duration: 0.7, type: 'fade', fade: 'out', easing: 'ease-in-out' }
      ]
    });
    time = 3;

    const imgbbKey = process.env.IMGBB_API_KEY;

    async function uploadToImgbb(buffer, mimetype) {
      if (!imgbbKey) return `data:${mimetype};base64,${buffer.toString('base64')}`;
      const b64 = buffer.toString('base64');
      const form = new URLSearchParams();
      form.append('image', b64);
      const r = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: 'POST', body: form
      });
      const d = await r.json();
      if (d.success) { console.log(`  imgbb: ${d.data.url}`); return d.data.url; }
      return `data:${mimetype};base64,${b64}`;
    }

    // Ken Burns animations — cinematic camera movement
    const animStyles = [
      // Slow zoom in
      [{ easing: 'linear', type: 'scale', from: '100%', to: '120%' }],
      // Slow zoom out
      [{ easing: 'linear', type: 'scale', from: '120%', to: '100%' }],
      // Pan left
      [{ easing: 'linear', type: 'pan', x_from: '-10%', x_to: '10%' }],
      // Pan right
      [{ easing: 'linear', type: 'pan', x_from: '10%', x_to: '-10%' }],
      // Pan up with zoom
      [{ easing: 'linear', type: 'scale', from: '110%', to: '120%' }],
    ];

    // Image slides with Ken Burns effect
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imgUrl = await uploadToImgbb(file.buffer, file.mimetype);
      const anim = animStyles[i % animStyles.length];

      elements.push({
        type: 'image',
        track: 1,
        time,
        duration,
        source: imgUrl,
        width: '100%',
        height: '100%',
        x: '50%',
        y: '50%',
        x_alignment: '50%',
        y_alignment: '50%',
        fit: 'cover',
        animations: anim
      });

      // Fade in/out text caption
      if (title && i === 0) {
        elements.push({
          type: 'text', track: 2,
          time: time + 0.5, duration: duration - 1,
          text: title,
          font_family: 'Montserrat', font_weight: '600', font_size: '4 vmin',
          fill_color: '#ffffff', shadow_color: 'rgba(0,0,0,0.8)', shadow_blur: '2 vmin',
          x_alignment: '50%', y_alignment: '88%', width: '80%',
          animations: [
            { time: 0, duration: 0.5, type: 'fade', fade: 'in', easing: 'ease-in-out' },
            { time: 'end-0.5', duration: 0.5, type: 'fade', fade: 'out', easing: 'ease-in-out' }
          ]
        });
      }

      time += duration;
    }

    // End card
    elements.push({
      type: 'text', track: 2, time: time + 0.5, duration: 2.5,
      text: title.toUpperCase(),
      font_family: 'Montserrat', font_weight: '900', font_size: '9 vmin',
      fill_color: '#FFD700', shadow_color: 'rgba(0,0,0,0.9)', shadow_blur: '3 vmin',
      x_alignment: '50%', y_alignment: '50%', width: '85%',
      animations: [
        { time: 0, duration: 1, type: 'fade', fade: 'in', easing: 'ease-in-out' },
        { time: 2, duration: 0.5, type: 'fade', fade: 'out', easing: 'ease-in-out' }
      ]
    });

    // Background music
    const musicUrl = MUSIC_URLS[music];
    if (musicUrl) {
      elements.push({
        type: 'audio', track: 3, time: 0,
        source: musicUrl, volume: 0.2,
        audio_fade_in: 2, audio_fade_out: 2
      });
    }

    const totalDur = time + 3;
    const payload = {
      output_format: 'mp4',
      source: {
        width: 1920,
        height: 1080,
        frame_rate: 25,
        duration: totalDur,
        fill_color: '#000000',
        elements
      }
    };

    console.log(`Sending to Creatomate: ${elements.length} elements, ~${totalDur}s`);

    const r = await fetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();
    console.log(`Creatomate HTTP ${r.status}:`, raw.slice(0, 200));
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: raw.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ error: data?.message || raw.slice(0, 200) });
    const render = Array.isArray(data) ? data[0] : data;
    console.log('Render ID:', render.id);
    res.json({ success: true, project: render.id });

  } catch (err) {
    console.error('images-to-video error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/render ────────────────────────────────────────────────
// Correct Creatomate v1 format:
// POST /v1/renders with body: { "source": { RenderScript } }
// RenderScript: { "output_format", "width", "height", "elements": [...] }
// Each element needs "track" and "time" for timeline positioning
app.post('/api/render', async (req, res) => {
  try {
    const { video }  = req.body;
    const cmKey      = process.env.CREATOMATE_API_KEY;
    const pexelsKey  = process.env.PEXELS_API_KEY;
    if (!cmKey)         return res.status(500).json({ error: 'CREATOMATE_API_KEY not set' });
    if (!video?.scenes) return res.status(400).json({ error: 'Video scenes missing' });

    const FALLBACK = 'https://cdn.creatomate.com/demo/video1.mp4';

    const videoElements = [];
    const textElements  = [];

    let time = 0;

    // ── Title card ──────────────────────────────────────────
    const TITLE_DUR = 4;
    const titleClip = pexelsKey ? await searchPexels('dark cinematic dramatic action', pexelsKey) : null;

    videoElements.push({
      type: 'video',
      track: 1,
      time,
      duration: TITLE_DUR,
      source: titleClip || FALLBACK,
      volume: 0,
      fit: 'cover'
    });
    textElements.push({
      type: 'text',
      track: 2,
      time: time + 0.4,
      duration: TITLE_DUR - 0.4,
      text: (video.title || 'COMING SOON').toUpperCase(),
      font_family: 'Montserrat',
      font_weight: '900',
      font_size: '9 vmin',
      fill_color: '#FFD700',
      shadow_color: 'rgba(0,0,0,0.9)',
      shadow_blur: '3 vmin',
      x_alignment: '50%',
      y_alignment: '50%',
      width: '85%',
      animations: [
        { time: 0, duration: 0.8, type: 'fade', fade: 'in', easing: 'ease-in-out' },
        { time: 'end-0.6', duration: 0.6, type: 'fade', fade: 'out', easing: 'ease-in-out' }
      ]
    });
    time += TITLE_DUR;

    // ── Scenes ───────────────────────────────────────────────
    for (let i = 0; i < video.scenes.length; i++) {
      const scene = video.scenes[i];
      const dur   = Math.max(parseDuration(scene.duration), 6);
      const clip  = pexelsKey ? await searchPexels(sceneQuery(scene), pexelsKey) : null;

      videoElements.push({
        type: 'video',
        track: 1,
        time,
        duration: dur,
        source: clip || FALLBACK,
        volume: 0,
        fit: 'cover',
        animations: [
          { time: 0, duration: dur, easing: 'linear',
            type: 'scale',
            from: i % 2 === 0 ? '100%' : '108%',
            to:   i % 2 === 0 ? '108%' : '100%' }
        ]
      });

      const narration = (scene.narration || scene.description || '')
        .replace(/[^\w\s.,!?'"()\-:]/g, '').trim();
      const line = narration.split(/[.!?]/)[0].trim().slice(0, 65);

      if (line.length > 2) {
        textElements.push({
          type: 'text',
          track: 2,
          time: time + 1,
          duration: dur - 2,
          text: line,
          font_family: 'Montserrat',
          font_weight: '700',
          font_size: '6 vmin',
          fill_color: '#ffffff',
          shadow_color: 'rgba(0,0,0,0.95)',
          shadow_blur: '2.5 vmin',
          x_alignment: '50%',
          y_alignment: '75%',
          width: '80%',
          animations: [
            { time: 0, duration: 0.5, type: 'fade', fade: 'in', easing: 'ease-in-out' },
            { time: 'end-0.5', duration: 0.5, type: 'fade', fade: 'out', easing: 'ease-in-out' }
          ]
        });
      }

      // Voiceover using ElevenLabs free TTS
      if (narration.length > 3 && process.env.ELEVENLABS_API_KEY) {
        try {
          const voiceUrl = await generateVoice(narration.slice(0, 120), process.env.ELEVENLABS_API_KEY);
          if (voiceUrl) {
            videoElements.push({
              type: 'audio',
              track: 3,
              time: time + 0.5,
              duration: dur - 1,
              source: voiceUrl,
              volume: 1.0
            });
          }
        } catch (e) { console.log(`  Voice error scene ${i}: ${e.message}`); }
      }

      time += dur;
    }

    // ── End card ─────────────────────────────────────────────
    const END_DUR  = 5;
    const endClip  = pexelsKey ? await searchPexels('dark city night cinematic', pexelsKey) : null;

    videoElements.push({
      type: 'video',
      track: 1,
      time,
      duration: END_DUR,
      source: endClip || FALLBACK,
      volume: 0,
      fit: 'cover'
    });
    textElements.push({
      type: 'text',
      track: 2,
      time: time + 0.8,
      duration: END_DUR - 0.8,
      text: (video.title || '').toUpperCase(),
      font_family: 'Montserrat',
      font_weight: '900',
      font_size: '9 vmin',
      fill_color: '#FFD700',
      shadow_color: 'rgba(0,0,0,0.9)',
      shadow_blur: '3 vmin',
      x_alignment: '50%',
      y_alignment: '42%',
      width: '85%',
      animations: [{ time: 0, duration: 1, type: 'fade', fade: 'in', easing: 'ease-in-out' }]
    });
    textElements.push({
      type: 'text',
      track: 2,
      time: time + 1.5,
      duration: END_DUR - 1.5,
      text: 'COMING SOON',
      font_family: 'Montserrat',
      font_weight: '300',
      font_size: '3.5 vmin',
      fill_color: '#ffffff',
      shadow_color: 'rgba(0,0,0,0.9)',
      shadow_blur: '2 vmin',
      x_alignment: '50%',
      y_alignment: '58%',
      width: '85%',
      letter_spacing: '5%',
      animations: [{ time: 0, duration: 1, type: 'fade', fade: 'in', easing: 'ease-in-out' }]
    });

    // ── Background music ──────────────────────────────────────
    // Using Internet Archive public domain cinematic music
    videoElements.push({
      type: 'audio',
      track: 4,
      time: 0,
      source: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      volume: 0.15,
      audio_fade_in: 2,
      audio_fade_out: 2
    });

    // ── Build final payload ───────────────────────────────────
    const totalDuration = time + END_DUR;
    const renderScript = {
      output_format: 'mp4',
      width: 1920,
      height: 1080,
      frame_rate: 25,
      duration: totalDuration,
      elements: [
        ...videoElements,
        ...textElements
      ]
    };

    const body = { source: renderScript };

    console.log(`\nSending to Creatomate: ${renderScript.elements.length} elements, ~${time + END_DUR}s`);
    console.log('Sample element:', JSON.stringify(renderScript.elements[0]));

    const r = await fetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cmKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const raw = await r.text();
    console.log(`Creatomate HTTP ${r.status}:`, raw.slice(0, 400));

    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'Non-JSON: ' + raw.slice(0,200) }); }
    if (!r.ok) return res.status(r.status).json({ error: data?.message || JSON.stringify(data).slice(0,300) });

    const render = Array.isArray(data) ? data[0] : data;
    console.log('Render ID:', render.id, '| Status:', render.status);
    res.json({ success: true, project: render.id, renderId: render.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/render/status ─────────────────────────────────────────
app.get('/api/render/status/:id', async (req, res) => {
  const cmKey = process.env.CREATOMATE_API_KEY;
  if (!cmKey) return res.status(500).json({ error: 'CREATOMATE_API_KEY not set' });
  try {
    const r = await fetch(`https://api.creatomate.com/v1/renders/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${cmKey}` }
    });
    const data = await r.json();
    const status = data.status || '';
    const url    = data.url    || '';
    const errMsg = data.error_message || '';
    console.log(`Status: "${status}" | URL: "${url}" | Err: "${errMsg}"`);
    if (status === 'failed') console.log('FAILED:', JSON.stringify(data, null, 2));
    let mapped = status;
    if (status === 'succeeded') mapped = 'done';
    if (['rendering','planned','waiting','transcribing'].includes(status)) mapped = 'running';
    res.json({ success: true, status: mapped, url, message: errMsg, data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /api/debug ─────────────────────────────────────────────────
app.get('/api/debug/:id', async (req, res) => {
  const cmKey = process.env.CREATOMATE_API_KEY;
  if (!cmKey) return res.status(500).json({ error: 'No key' });
  try {
    const r = await fetch(`https://api.creatomate.com/v1/renders/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${cmKey}` }
    });
    res.setHeader('Content-Type','application/json');
    res.send(JSON.stringify(await r.json(), null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n🎬 AI Video Generator running at http://localhost:${PORT}\n`);
  console.log('  GROQ_API_KEY       -', process.env.GROQ_API_KEY       ? '✅ set' : '❌ MISSING');
  console.log('  CREATOMATE_API_KEY -', process.env.CREATOMATE_API_KEY ? '✅ set' : '❌ MISSING');
  console.log('  PEXELS_API_KEY     -', process.env.PEXELS_API_KEY     ? '✅ set' : '⚠️  not set');
  console.log('  ELEVENLABS_API_KEY -', process.env.ELEVENLABS_API_KEY ? '✅ set (voiceover enabled)' : '⚠️  not set (no voiceover)');
  console.log('  SERVER_HOST        -', process.env.SERVER_HOST        || '⚠️  not set (set to your Railway URL for voiceover)');
  console.log('');
});
