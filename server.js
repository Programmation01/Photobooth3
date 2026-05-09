/**
 * ============================================================
 *  PHOTOBOOTH BAL 2026 — Serveur Principal
 *  Node.js + Express + WebSocket
 *  Rôles : signaling WebRTC, stockage photos, QR code, email
 * ============================================================
 */

require('dotenv').config();

const express   = require('express');
const { WebSocketServer } = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode    = require('qrcode');

// ── Config ────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
// BASE_URL : utilisé comme fallback uniquement.
// En production (Render) on résout l'URL depuis les headers de chaque requête
// pour éviter que le QR code pointe vers localhost.
const BASE_URL_FALLBACK = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PHOTOS_DIR = process.env.RENDER_DISK_PATH
                   ? path.join(process.env.RENDER_DISK_PATH, 'photos')
                   : path.join(__dirname, 'photos');
const BREVO_KEY  = process.env.BREVO_API_KEY  || '';
const BREVO_FROM = process.env.BREVO_SENDER   || 'photobooth@bal2026.fr';
const MAX_GALLERY = 100;

// ── Résolution URL publique ───────────────────────────────────
// Render injecte X-Forwarded-Proto et Host dans chaque requête.
// C'est la seule façon fiable d'obtenir l'URL publique sans configurer BASE_URL.
function getBaseUrl(req) {
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host  = req.get('x-forwarded-host')  || req.get('host');
    if (host) return `${proto}://${host}`;
  }
  return BASE_URL_FALLBACK;
}

// Créer le dossier photos s'il n'existe pas
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ── Express ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' })); // Limite upload à 25 Mo

// ── Routes pages ─────────────────────────────────────────────
app.get('/',       (_, res) => res.sendFile(path.join(__dirname, 'public', 'tablet.html')));
app.get('/phone',  (_, res) => res.sendFile(path.join(__dirname, 'public', 'phone.html')));
app.get('/tablet', (_, res) => res.sendFile(path.join(__dirname, 'public', 'tablet.html')));

// ── Route : servir une photo ─────────────────────────────────
// IMPORTANT : route stable → même URL quel que soit le redémarrage du serveur
app.get('/photo/:id', (req, res) => {
  const id   = req.params.id.replace(/[^a-zA-Z0-9-]/g, ''); // sanitize
  const file = path.join(PHOTOS_DIR, `${id}.jpg`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Photo introuvable' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// ── Route : télécharger une photo ───────────────────────────
app.get('/download/:id', (req, res) => {
  const id   = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
  const file = path.join(PHOTOS_DIR, `${id}.jpg`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Photo introuvable' });
  res.download(file, `Bal2026-${id.slice(0, 8)}.jpg`);
});

// ── Route : upload photo (envoyée depuis la tablette) ────────
app.post('/api/upload', async (req, res) => {
  try {
    const { data, type } = req.body;
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const id     = uuidv4();
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length < 1000) {
      return res.status(400).json({ error: 'Image trop petite ou corrompue' });
    }

    // Écriture fichier
    const filePath  = path.join(PHOTOS_DIR, `${id}.jpg`);
    const metaPath  = path.join(PHOTOS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, buffer);

    // CORRECTIF QR CODE : résoudre l'URL depuis les headers de la requête
    // évite le problème "localhost" sur Render
    const BASE_URL = getBaseUrl(req);

    // Métadonnées
    const meta = {
      id,
      type:        type || 'single',
      url:         `${BASE_URL}/photo/${id}`,
      downloadUrl: `${BASE_URL}/download/${id}`,
      size:        buffer.length,
      createdAt:   new Date().toISOString()
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Génération QR code (lien de téléchargement)
    const qrCode = await QRCode.toDataURL(meta.downloadUrl, {
      width:  280,
      margin: 2,
      color:  { dark: '#080810', light: '#f5f0e8' },
      errorCorrectionLevel: 'M'
    });

    // Diffuser aux tablets connectées
    broadcastToTablets({
      type:        'photo-ready',
      id,
      url:         meta.url,
      downloadUrl: meta.downloadUrl,
      photoType:   type || 'single',
      qrCode,
      createdAt:   meta.createdAt
    });

    res.json({ success: true, id, url: meta.url, downloadUrl: meta.downloadUrl, qrCode });

  } catch (err) {
    console.error('[upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route : galerie ──────────────────────────────────────────
app.get('/api/gallery', (req, res) => {
  try {
    const photos = fs.readdirSync(PHOTOS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(PHOTOS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, MAX_GALLERY);
    res.json(photos);
  } catch {
    res.json([]);
  }
});

// ── Route : QR code à la demande ─────────────────────────────
app.get('/api/qr/:id', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
  try {
    const qrCode = await QRCode.toDataURL(`${BASE_URL}/download/${id}`, {
      width: 280, margin: 2,
      color: { dark: '#080810', light: '#f5f0e8' }
    });
    res.json({ qrCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route : supprimer une photo (admin) ─────────────────────
app.delete('/api/photo/:id', (req, res) => {
  const id  = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
  const jpg = path.join(PHOTOS_DIR, `${id}.jpg`);
  const jsn = path.join(PHOTOS_DIR, `${id}.json`);
  [jpg, jsn].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  broadcastToTablets({ type: 'photo-deleted', id });
  res.json({ success: true });
});

// ── Route : envoi email via Brevo ────────────────────────────
// Brevo = API HTTP, pas SMTP → zéro timeout réseau
app.post('/api/email', async (req, res) => {
  const { to, photoId } = req.body;

  if (!to || !photoId) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  if (!BREVO_KEY) {
    return res.status(503).json({ error: 'Service email non configuré (BREVO_API_KEY manquant)' });
  }

  // Résoudre l'URL depuis la requête (même correctif que /api/upload)
  const BASE_URL    = getBaseUrl(req);
  const downloadUrl = `${BASE_URL}/download/${photoId}`;
  const viewUrl     = `${BASE_URL}/photo/${photoId}`;

  // Lire la photo depuis le disque pour la joindre
  const filePath = path.join(PHOTOS_DIR, `${photoId}.jpg`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Photo introuvable' });
  }

  let attachmentBase64;
  try {
    attachmentBase64 = fs.readFileSync(filePath).toString('base64');
  } catch (err) {
    console.error('[email] Lecture photo:', err.message);
    return res.status(500).json({ error: 'Impossible de lire la photo' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      BREVO_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender:  { name: 'Photobooth Bal 2026', email: BREVO_FROM },
        to:      [{ email: to }],
        subject: '✨ Votre souvenir du Bal 2026 est prêt !',
        htmlContent: buildEmailHtml(downloadUrl, viewUrl),
        // ── PIÈCE JOINTE : photo en base64 ───────────────────
        attachment: [
          {
            content: attachmentBase64,
            name:    `Bal2026-${photoId.slice(0, 8)}.jpg`
          }
        ]
      }),
      signal: AbortSignal.timeout(15000) // 15s max (Brevo est rapide)
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`Brevo ${response.status}: ${JSON.stringify(errBody)}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[email]', err.message);
    // Fallback : renvoyer le lien direct même si l'email échoue
    res.status(500).json({
      error:       err.message,
      fallbackUrl: downloadUrl
    });
  }
});

function buildEmailHtml(downloadUrl, viewUrl) {
  return `
<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;background:#080810;font-family:Georgia,serif">
<div style="max-width:600px;margin:40px auto;background:#12121e;border:1px solid #d4a843;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1a1228,#0c1a0c);padding:40px;text-align:center;border-bottom:1px solid #d4a843">
    <h1 style="color:#d4a843;margin:0;font-size:32px;letter-spacing:3px">BAL 2026</h1>
    <p style="color:#f0c870;margin:8px 0 0;font-size:16px;letter-spacing:1px">✨ Votre souvenir est prêt ✨</p>
  </div>
  <div style="padding:40px;text-align:center">
    <p style="color:#f5f0e8;font-size:18px;line-height:1.6;margin:0 0 32px">
      Une belle soirée mérite un beau souvenir.<br>Votre photo du Bal 2026 vous attend !
    </p>
    <a href="${downloadUrl}" style="display:inline-block;background:linear-gradient(135deg,#d4a843,#f0c870);color:#080810;padding:16px 40px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:18px;letter-spacing:1px;margin-bottom:16px">
      ⬇️ Télécharger ma photo
    </a>
    <br>
    <a href="${viewUrl}" style="color:#d4a843;font-size:14px;text-decoration:none">Voir en ligne</a>
    <p style="color:#666;font-size:12px;margin-top:40px">Ce lien est valable 30 jours. Photobooth Bal 2026.</p>
  </div>
</div>
</body></html>`;
}

// ── WebSocket Hub ─────────────────────────────────────────────
// Architecture : 1 téléphone (caméra) ↔ N tablettes (UI)
// Signaling WebRTC : phone crée l'offer → tablette répond

const wss = new WebSocketServer({ server });

// Registre des clients connectés
const phoneClients  = new Set();   // en théorie 1 seul
const tabletClients = new Set();

wss.on('connection', (ws, req) => {
  let role = null;
  console.log(`[ws] Nouvelle connexion ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── Enregistrement du client
      case 'register':
        role = msg.role; // 'phone' ou 'tablet'
        if (role === 'phone') {
          phoneClients.add(ws);
          broadcastToTablets({ type: 'phone-connected' });
          console.log(`[ws] 📱 Téléphone enregistré`);
          // Si une tablette est déjà connectée, signaler au téléphone
          if (tabletClients.size > 0) {
            safesSend(ws, { type: 'tablet-ready' });
          }
        } else if (role === 'tablet') {
          tabletClients.add(ws);
          console.log(`[ws] 📟 Tablette enregistrée (total: ${tabletClients.size})`);
          // Informer la tablette de l'état actuel du téléphone
          if (phoneClients.size > 0) {
            safesSend(ws, { type: 'phone-connected' });
            // Déclencher un nouvel offer WebRTC
            broadcastToPhones({ type: 'request-offer' });
          }
        }
        break;

      // ── Signaling WebRTC : Phone → Tablette
      case 'offer':
        broadcastToTablets({ type: 'offer', sdp: msg.sdp });
        break;

      // ── Signaling WebRTC : Tablette → Phone
      case 'answer':
        broadcastToPhones({ type: 'answer', sdp: msg.sdp });
        break;

      // ── ICE candidates (bidirectionnel)
      case 'ice':
        if (role === 'phone') {
          broadcastToTablets({ type: 'ice', candidate: msg.candidate });
        } else if (role === 'tablet') {
          broadcastToPhones({ type: 'ice', candidate: msg.candidate });
        }
        break;

      // ── Déclenchement capture (tablette → téléphone)
      case 'capture-trigger':
        // Signaler au téléphone de s'allumer (flash)
        broadcastToPhones({ type: 'flash' });
        break;

      // ── Ping/pong keepalive
      case 'ping':
        safesSend(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (role === 'phone') {
      phoneClients.delete(ws);
      broadcastToTablets({ type: 'phone-disconnected' });
      console.log('[ws] 📱 Téléphone déconnecté');
    } else if (role === 'tablet') {
      tabletClients.delete(ws);
      console.log(`[ws] 📟 Tablette déconnectée (restant: ${tabletClients.size})`);
    }
  });

  ws.on('error', (err) => console.error('[ws error]', err.message));
});

function safesSend(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (e) { /* ignore */ }
}

function broadcastToTablets(obj) {
  tabletClients.forEach(ws => safesSend(ws, obj));
}

function broadcastToPhones(obj) {
  phoneClients.forEach(ws => safesSend(ws, obj));
}

// ── Démarrage ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║      🎉  PHOTOBOOTH BAL 2026  🎉            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Serveur  → ${BASE_URL_FALLBACK.padEnd(33)}║`);
  console.log(`║  📱 Tél   → ${(BASE_URL_FALLBACK + '/phone').padEnd(33)}║`);
  console.log(`║  📟 Table → ${(BASE_URL_FALLBACK + '/tablet').padEnd(33)}║`);
  console.log(`║  📂 Photos→ ${PHOTOS_DIR.padEnd(33)}║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
