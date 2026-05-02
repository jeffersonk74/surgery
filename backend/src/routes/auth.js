// backend/src/routes/auth.js
// Routes d'authentification (login, register)

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_jwt_telechirurgie_2024';

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    
    // Chercher l'utilisateur avec Prisma
    const user = await prisma.user.findUnique({
      where: { email }
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    // Vérifier le mot de passe
    const isValid = await bcrypt.compare(password, user.password);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    
    // Générer JWT
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role,
        nom: user.nom,
        prenom: user.prenom
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role
      }
    });
    
  } catch (error) {
    console.error('[AUTH] Erreur login:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Register (créer un compte - accessible uniquement aux admins ou pour setup initial)
router.post('/register', async (req, res) => {
  try {
    const { email, password, nom, prenom, role } = req.body;
    
    if (!email || !password || !nom || !prenom || !role) {
      return res.status(400).json({ 
        error: 'Tous les champs sont requis: email, password, nom, prenom, role' 
      });
    }
    
    if (!['chirurgien', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'Role invalide (chirurgien ou assistant)' });
    }
    
    // Vérifier si l'email existe déjà
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true }
    });
    
    if (existing) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    
    // Hacher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Créer l'utilisateur avec Prisma
    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        nom,
        prenom,
        role: role === 'chirurgien' ? 'chirurgien' : 'assistant'
      }
    });
    
    res.status(201).json({
      message: 'Utilisateur créé avec succès',
      userId: newUser.id
    });
    
  } catch (error) {
    console.error('[AUTH] Erreur register:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Middleware pour vérifier le token JWT
export function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

// Route protégée exemple - récupérer le profil
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, email: true, nom: true, prenom: true, role: true, createdAt: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('[AUTH] Erreur profile:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
