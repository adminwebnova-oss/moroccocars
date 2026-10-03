import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db';
import { generateToken, requireAdminAuth, AuthRequest } from './server/auth';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = 3000;

// Setup Uploads Directory
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    cb(null, `mc_${Date.now()}_${safeName}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|avif|svg/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const mime = file.mimetype.toLowerCase();
    if (allowed.test(ext) || allowed.test(mime)) {
      cb(null, true);
    } else {
      cb(new Error('Format d\'image non supporté (JPEG, PNG, WEBP, AVIF acceptés)'));
    }
  }
});

// Middleware
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Static public and uploads serving
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/assets', express.static(path.join(process.cwd(), 'public', 'assets')));
app.use('/images', express.static(path.join(process.cwd(), 'public', 'images')));
app.use('/api/uploads', express.static(UPLOADS_DIR));

// Server-Sent Events (SSE) Client List for Real-time sync
const sseClients: Response[] = [];

app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// Broadcast changes to all connected SSE clients
function broadcastUpdate(type: string, payload?: any) {
  const message = JSON.stringify({ type, payload, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${message}\n\n`);
    } catch {
      // client disconnected
    }
  }
}

// Hook into DB saves to broadcast SSE updates
db.subscribe(() => {
  broadcastUpdate('DATABASE_UPDATED', {
    vehiclesCount: db.getAllVehicles().length,
    timestamp: new Date().toISOString()
  });
});

// -------------------------------------------------------------
// PUBLIC API ENDPOINTS
// -------------------------------------------------------------

// 1. Get Live Public Data (Vehicles, Destinations, Testimonials, Settings, AI Knowledge)
app.get('/api/public/data', (req: Request, res: Response) => {
  try {
    const data = db.getPublicData();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors de la récupération des données', details: err.message });
  }
});

// 2. Submit a Reservation from Public Booking Form
app.post('/api/public/reservations', (req: Request, res: Response) => {
  try {
    const {
      fullName,
      phone,
      email,
      vehicleId,
      vehicleName,
      pickupLocation,
      returnLocation,
      departureDate,
      departureTime,
      returnDate,
      returnTime,
      totalDays,
      totalPriceEur,
      selectedAddOns,
      message
    } = req.body;

    if (!fullName || !phone) {
      return res.status(400).json({ error: 'Nom complet et numéro de téléphone requis.' });
    }

    const reservation = db.createReservation({
      clientName: fullName,
      phone,
      email: email || '',
      vehicleId,
      vehicleName,
      pickupLocation,
      returnLocation,
      departureDate,
      departureTime,
      returnDate,
      returnTime,
      totalDays: Number(totalDays) || 1,
      totalPriceEur: Number(totalPriceEur) || 0,
      selectedAddOns: selectedAddOns || [],
      message: message || '',
      status: 'new'
    });

    broadcastUpdate('NEW_RESERVATION', reservation);
    res.status(201).json({ success: true, reservation });
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors de la réservation', details: err.message });
  }
});

// 3. Submit a Contact Message
app.post('/api/public/messages', (req: Request, res: Response) => {
  try {
    const { name, phone, email, subject, message } = req.body;

    if (!name || (!phone && !email)) {
      return res.status(400).json({ error: 'Nom et contact (Téléphone ou Email) requis.' });
    }

    const contactMessage = db.createMessage({
      name,
      phone: phone || '',
      email: email || '',
      subject: subject || 'Demande de contact',
      message: message || ''
    });

    broadcastUpdate('NEW_MESSAGE', contactMessage);
    res.status(201).json({ success: true, message: contactMessage });
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors de l\'envoi du message', details: err.message });
  }
});

// 4. AI Assistant Chat Endpoint (Server-Side Grounded with Gemini API + Live Database)
app.post('/api/public/ai/chat', async (req: Request, res: Response) => {
  try {
    const { message, lang = 'fr' } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message requis.' });
    }

    const aiConfig = db.getAiKnowledge();
    if (!aiConfig.enabled) {
      return res.json({
        text: "Le service d'assistance en ligne est actuellement indisponible. Veuillez nous contacter directement par WhatsApp au +212 661-290540."
      });
    }

    const vehicles = db.getPublicData().vehicles;
    const vehicleSummary = vehicles
      .map((v) => `• ${v.brand} ${v.model} (${v.category}, ${v.seats} places, ${v.transmission}, ${v.fuel}, ${v.pricePerDay} €/jour) - ID: ${v.id}`)
      .join('\n');

    // Try Gemini API if key is provided
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const systemPrompt = `
Tu es l'assistant de conciergerie automobile haut de gamme de MOROCCO CARS (Maroc).
Ton rôle est de renseigner les clients avec élégance, clarté et professionnalisme sur la location de voitures au Maroc.

Informations officielles de l'entreprise :
- Nom : ${aiConfig.companyName}
- Adresse : ${aiConfig.headquarters}
- Téléphone & WhatsApp : ${aiConfig.whatsapp}
- Email : ${aiConfig.email}
- Politiques : ${aiConfig.rentalPolicies}
- Conditions d'âge : ${aiConfig.driverRequirements}
- Dépôt / Caution : ${aiConfig.depositTerms}
- Services inclus : ${aiConfig.includedServices}
- Instructions spéciales : ${aiConfig.customSystemInstructions}

FLOTTE ACTUELLE EN TEMPS RÉEL (SOURCE DE VÉRITÉ BASE DE DONNÉES) :
${vehicleSummary}

Règles de réponse :
1. Réponds toujours dans la langue du client (${lang === 'ar' ? 'Arabe' : lang === 'en' ? 'Anglais' : 'Français'}).
2. Cite toujours les prix exacts de la flotte ci-dessus (ex: Dacia Logan à 30 €/jour, Audi Q8 à 220 €/jour). Ne modifie jamais un prix.
3. Si le client demande une recommandation, propose 1 à 2 modèles précis avec leurs atouts pour les routes marocaines.
4. Reste concis (maximum 2 à 3 paragraphes), chaleureux et direct.
`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            { role: 'user', parts: [{ text: `${systemPrompt}\n\nQuestion du client: ${message}` }] }
          ]
        });

        const generatedText = response.text || '';
        return res.json({ text: generatedText });
      } catch (geminiErr: any) {
        console.warn('Gemini API fallback to local engine:', geminiErr?.message);
      }
    }

    // Fallback: Smart local rule-based response using live database vehicles
    const q = message.toLowerCase();
    let reply = '';
    if (q.includes('moins cher') || q.includes('budget') || q.includes('économique') || q.includes('cheapest')) {
      const cheapCars = [...vehicles].sort((a, b) => a.pricePerDay - b.pricePerDay).slice(0, 3);
      reply = `Nos véhicules les plus économiques débutent à partir de **${cheapCars[0]?.pricePerDay || 30} €/jour** avec la **${cheapCars[0]?.brand} ${cheapCars[0]?.model}**.\n\nNous proposons également la **${cheapCars[1]?.brand} ${cheapCars[1]?.model}** (${cheapCars[1]?.pricePerDay} €/jour) et la **${cheapCars[2]?.brand} ${cheapCars[2]?.model}** (${cheapCars[2]?.pricePerDay} €/jour). Toutes nos locations incluent la climatisation et le kilométrage illimité.`;
    } else if (q.includes('7 places') || q.includes('famille') || q.includes('groupe') || q.includes('7 seats')) {
      const largeCars = vehicles.filter(v => v.seats >= 7 || v.category === '7_PLACES' || v.category === 'SUV');
      reply = `Pour les familles ou groupes, nous recommandons le **${largeCars[0]?.brand} ${largeCars[0]?.model}** (${largeCars[0]?.pricePerDay} €/jour) avec ses ${largeCars[0]?.seats || 7} vraies places et son grand coffre, parfait pour les longs trajets à travers le Maroc.`;
    } else if (q.includes('contact') || q.includes('adresse') || q.includes('agence') || q.includes('où')) {
      reply = `Notre agence principale est située au **${aiConfig.headquarters}**. Nous effectuons également la livraison et la restitution 24h/24 directement à l'Aéroport Mohammed V de Casablanca, à Marrakech, ainsi que dans tous les aéroports et hôtels du Maroc. Contactez-nous au **${aiConfig.phone}**.`;
    } else {
      reply = `Morocco Cars vous propose une flotte sélectionnée de ${vehicles.length} véhicules récents, des citadines économiques aux SUV 4x4 de prestige. Vous pouvez réserver directement en ligne ou nous joindre sur WhatsApp au **${aiConfig.whatsapp}** pour une confirmation express.`;
    }

    res.json({ text: reply });
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur assistant IA', details: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN AUTHENTICATION & SECURE ENDPOINTS
// -------------------------------------------------------------

// Admin Login
app.post('/api/admin/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis.' });
    }

    const admin = db.getAdminByEmail(email);
    if (!admin) {
      return res.status(401).json({ error: 'Identifiants administrateur incorrects.' });
    }

    const isValid = bcrypt.compareSync(password, admin.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Identifiants administrateur incorrects.' });
    }

    db.recordAdminLogin(admin.email);

    const token = generateToken({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role
    });

    res.json({
      success: true,
      token,
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        lastLogin: admin.lastLogin
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors de la connexion', details: err.message });
  }
});

// Verify Current Admin Session
app.get('/api/admin/me', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json({ success: true, user: req.adminUser });
});

// Admin Stats
app.get('/api/admin/stats', requireAdminAuth, (req: AuthRequest, res: Response) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors du calcul des statistiques', details: err.message });
  }
});

// Admin Image Upload
app.post('/api/admin/upload', requireAdminAuth, upload.single('image'), (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier image fourni.' });
    }
    const publicUrl = `/api/uploads/${req.file.filename}`;
    res.json({ success: true, url: publicUrl, filename: req.file.filename });
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors du téléversement de l\'image', details: err.message });
  }
});

// --- Admin Vehicles Endpoints ---

app.get('/api/admin/vehicles', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllVehicles());
});

app.post('/api/admin/vehicles', requireAdminAuth, (req: AuthRequest, res: Response) => {
  try {
    const vehicle = db.createVehicle(req.body);
    broadcastUpdate('VEHICLE_CREATED', vehicle);
    res.status(201).json(vehicle);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/vehicles/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  try {
    const updated = db.updateVehicle(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Véhicule introuvable.' });
    broadcastUpdate('VEHICLE_UPDATED', updated);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/vehicles/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteVehicle(req.params.id);
  if (!success) return res.status(404).json({ error: 'Véhicule introuvable.' });
  broadcastUpdate('VEHICLE_DELETED', { id: req.params.id });
  res.json({ success: true });
});

// --- Admin Reservations Endpoints ---

app.get('/api/admin/reservations', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllReservations());
});

app.post('/api/admin/reservations', requireAdminAuth, (req: AuthRequest, res: Response) => {
  try {
    const reservation = db.createReservation(req.body);
    broadcastUpdate('RESERVATION_CREATED', reservation);
    res.status(201).json(reservation);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/reservations/:id/status', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  const updated = db.updateReservationStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'Réservation introuvable.' });
  broadcastUpdate('RESERVATION_STATUS_UPDATED', updated);
  res.json(updated);
});

app.delete('/api/admin/reservations/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteReservation(req.params.id);
  if (!success) return res.status(404).json({ error: 'Réservation introuvable.' });
  broadcastUpdate('RESERVATION_DELETED', { id: req.params.id });
  res.json({ success: true });
});

// --- Admin Clients Endpoints ---

app.get('/api/admin/clients', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllClients());
});

app.put('/api/admin/clients/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const updated = db.updateClient(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(updated);
});

app.delete('/api/admin/clients/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteClient(req.params.id);
  if (!success) return res.status(404).json({ error: 'Client introuvable.' });
  res.json({ success: true });
});

// --- Admin Messages Endpoints ---

app.get('/api/admin/messages', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllMessages());
});

app.put('/api/admin/messages/:id/status', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  const updated = db.updateMessageStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'Message introuvable.' });
  broadcastUpdate('MESSAGE_STATUS_UPDATED', updated);
  res.json(updated);
});

app.delete('/api/admin/messages/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteMessage(req.params.id);
  if (!success) return res.status(404).json({ error: 'Message introuvable.' });
  res.json({ success: true });
});

// --- Admin Testimonials Endpoints ---

app.get('/api/admin/testimonials', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllTestimonials());
});

app.post('/api/admin/testimonials', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const created = db.createTestimonial(req.body);
  broadcastUpdate('TESTIMONIALS_UPDATED', created);
  res.status(201).json(created);
});

app.put('/api/admin/testimonials/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const updated = db.updateTestimonial(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Témoignage introuvable.' });
  broadcastUpdate('TESTIMONIALS_UPDATED', updated);
  res.json(updated);
});

app.delete('/api/admin/testimonials/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteTestimonial(req.params.id);
  if (!success) return res.status(404).json({ error: 'Témoignage introuvable.' });
  broadcastUpdate('TESTIMONIALS_UPDATED', { id: req.params.id });
  res.json({ success: true });
});

// --- Admin Destinations Endpoints ---

app.get('/api/admin/destinations', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAllDestinations());
});

app.post('/api/admin/destinations', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const created = db.createDestination(req.body);
  broadcastUpdate('DESTINATIONS_UPDATED', created);
  res.status(201).json(created);
});

app.put('/api/admin/destinations/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const updated = db.updateDestination(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Destination introuvable.' });
  broadcastUpdate('DESTINATIONS_UPDATED', updated);
  res.json(updated);
});

app.delete('/api/admin/destinations/:id', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const success = db.deleteDestination(req.params.id);
  if (!success) return res.status(404).json({ error: 'Destination introuvable.' });
  broadcastUpdate('DESTINATIONS_UPDATED', { id: req.params.id });
  res.json({ success: true });
});

// --- Admin AI Knowledge & Site Settings Endpoints ---

app.get('/api/admin/ai-knowledge', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getAiKnowledge());
});

app.put('/api/admin/ai-knowledge', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const updated = db.updateAiKnowledge(req.body);
  broadcastUpdate('AI_KNOWLEDGE_UPDATED', updated);
  res.json(updated);
});

app.get('/api/admin/site-settings', requireAdminAuth, (req: AuthRequest, res: Response) => {
  res.json(db.getSiteSettings());
});

app.put('/api/admin/site-settings', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const updated = db.updateSiteSettings(req.body);
  broadcastUpdate('SITE_SETTINGS_UPDATED', updated);
  res.json(updated);
});

// Admin Password Update
app.put('/api/admin/security/password', requireAdminAuth, (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit comporter au moins 6 caractères.' });
    }

    const email = req.adminUser!.email;
    const admin = db.getAdminByEmail(email);
    if (!admin || !bcrypt.compareSync(currentPassword, admin.passwordHash)) {
      return res.status(400).json({ error: 'Le mot de passe actuel est incorrect.' });
    }

    db.updateAdminPassword(email, newPassword);
    res.json({ success: true, message: 'Mot de passe administrateur modifié avec succès.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Database Export & Raw Backup
app.get('/api/admin/database/export', requireAdminAuth, (req: AuthRequest, res: Response) => {
  const raw = db.getRawDatabase();
  res.setHeader('Content-Disposition', `attachment; filename=morocco_cars_backup_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(raw, null, 2));
});

// -------------------------------------------------------------
// AUTOMATIC DATABASE MANAGEMENT & HEALTH ENDPOINTS
// -------------------------------------------------------------

// 1. Health check for hosting / container / uptime monitoring
app.get('/api/db/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 2. Database Status & Configuration Inspector
app.get('/api/db/status', (req: Request, res: Response) => {
  try {
    const status = db.getStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: 'Erreur lors de la lecture du statut de la base de données', details: err.message });
  }
});

// 3. Trigger Idempotent Auto-Migration / Setup
app.post('/api/db/init', (req: Request, res: Response) => {
  try {
    const result = db.autoMigrate();
    res.json({
      success: true,
      message: result.isFreshInstall ? 'Installation initiale effectuée avec succès.' : 'Mise à jour et migrations appliquées avec succès.',
      appliedMigrations: result.appliedMigrations,
      status: db.getStatus()
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Échec de l\'initialisation automatique', details: err.message });
  }
});

// 4. Run Comprehensive Self-Test Suite (CRUD, Persistence, Data Preservation)
app.post('/api/db/test', (req: Request, res: Response) => {
  try {
    const testReport = db.runSelfTest();
    res.status(testReport.success ? 200 : 500).json(testReport);
  } catch (err: any) {
    res.status(500).json({ error: 'Échec des tests automatiques', details: err.message });
  }
});

// -------------------------------------------------------------
// VITE SPA FALLBACK & STATIC SERVING
// -------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Morocco Cars Backend] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
