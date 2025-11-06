const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false
});

// Initialize database table
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clay_sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        clay_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_id ON clay_sessions(session_id)
    `);
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Get or create clay state for a session
async function getClayState(sessionId) {
  try {
    const result = await pool.query(
      'SELECT clay_data FROM clay_sessions WHERE session_id = $1',
      [sessionId]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].clay_data;
    }
    
    // Create default clay state (a sphere mesh with vertices)
    const defaultState = createDefaultClay();
    
    await pool.query(
      'INSERT INTO clay_sessions (session_id, clay_data) VALUES ($1, $2)',
      [sessionId, JSON.stringify(defaultState)]
    );
    
    return defaultState;
  } catch (error) {
    console.error('Error getting clay state:', error);
    return createDefaultClay();
  }
}

// Update clay state in database
async function updateClayState(sessionId, clayData) {
  try {
    await pool.query(
      'UPDATE clay_sessions SET clay_data = $1, updated_at = CURRENT_TIMESTAMP WHERE session_id = $2',
      [JSON.stringify(clayData), sessionId]
    );
  } catch (error) {
    console.error('Error updating clay state:', error);
  }
}

// Create default clay (sphere geometry)
function createDefaultClay() {
  const radius = 1;
  const segments = 64; // Increased for higher polygon count
  const vertices = [];
  const indices = [];
  
  // Generate sphere vertices
  for (let i = 0; i <= segments; i++) {
    const theta = (i * Math.PI) / segments;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    
    for (let j = 0; j <= segments; j++) {
      const phi = (j * 2 * Math.PI) / segments;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      
      const x = radius * sinTheta * cosPhi;
      const y = radius * cosTheta;
      const z = radius * sinTheta * sinPhi;
      
      vertices.push({ x, y, z });
    }
  }
  
  // Generate indices
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      
      indices.push(a, b, a + 1);
      indices.push(b, b + 1, a + 1);
    }
  }
  
  return {
    vertices,
    indices,
    color: { r: 0.5, g: 0.5, b: 0.5 } // Grey color
  };
}

// Store active sessions
const activeSessions = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-session', async (sessionId) => {
    socket.join(sessionId);
    
    // Load clay state from database
    const clayState = await getClayState(sessionId);
    
    // Store session if not exists
    if (!activeSessions.has(sessionId)) {
      activeSessions.set(sessionId, {
        clayState,
        lastSave: Date.now()
      });
    }
    
    // Send current state to the new user
    socket.emit('clay-state', activeSessions.get(sessionId).clayState);
    
    // Notify others in the session
    socket.to(sessionId).emit('user-joined', socket.id);
    
    console.log(`User ${socket.id} joined session ${sessionId}`);
  });
  
  socket.on('sculpt-change', async (data) => {
    const { sessionId, vertexIndex, position } = data;
    
    if (!sessionId || vertexIndex === undefined || !position) {
      return;
    }
    
    const session = activeSessions.get(sessionId);
    if (!session) {
      return;
    }
    
    // Update the vertex position
    if (session.clayState.vertices[vertexIndex]) {
      session.clayState.vertices[vertexIndex] = position;
      
      // Broadcast to all other users in the session
      socket.to(sessionId).emit('vertex-update', {
        vertexIndex,
        position
      });
      
      // Save to database periodically (every 2 seconds) to avoid excessive writes
      const now = Date.now();
      if (now - session.lastSave > 2000) {
        await updateClayState(sessionId, session.clayState);
        session.lastSave = now;
      }
    }
  });
  
  socket.on('sculpt-batch', async (data) => {
    const { sessionId, updates } = data;
    
    if (!sessionId || !updates || !Array.isArray(updates)) {
      return;
    }
    
    const session = activeSessions.get(sessionId);
    if (!session) {
      return;
    }
    
    // Update all vertices in the batch
    for (const update of updates) {
      const { vertexIndex, position } = update;
      if (session.clayState.vertices[vertexIndex] && position) {
        session.clayState.vertices[vertexIndex] = position;
      }
    }
    
    // Broadcast batch update to all other users in the session
    socket.to(sessionId).emit('vertex-batch-update', {
      updates: updates
    });
    
    // Save to database periodically
    const now = Date.now();
    if (now - session.lastSave > 2000) {
      await updateClayState(sessionId, session.clayState);
      session.lastSave = now;
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// API endpoint to get session state
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const clayState = await getClayState(sessionId);
    res.json(clayState);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// API endpoint to reset session
app.post('/api/session/:sessionId/reset', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const defaultState = createDefaultClay();
    
    // Update or insert the session in database
    await pool.query(
      `INSERT INTO clay_sessions (session_id, clay_data, updated_at) 
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) 
       DO UPDATE SET clay_data = $2, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, JSON.stringify(defaultState)]
    );
    
    // Always update active session (create if doesn't exist)
    activeSessions.set(sessionId, {
      clayState: defaultState,
      lastSave: Date.now()
    });
    
    // Broadcast reset to all users in the session
    io.to(sessionId).emit('clay-state', defaultState);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting session:', error);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

const PORT = process.env.PORT || 3000;

// Initialize database and start server
initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

