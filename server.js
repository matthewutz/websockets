const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const SCULPT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const BREAK_DURATION_MS = 60 * 1000; // 1 minute

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
      `INSERT INTO clay_sessions (session_id, clay_data, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id)
       DO UPDATE SET clay_data = $2, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, JSON.stringify(clayData)]
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

function clayStateToOBJ(clayState) {
  if (!clayState) {
    return '';
  }

  const vertices = clayState.vertices ?? [];
  const indices = clayState.indices ?? [];
  const lines = ['# Sculpt Export', '# Vertices'];

  for (const vertex of vertices) {
    if (Array.isArray(vertex)) {
      lines.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    } else {
      lines.push(`v ${vertex.x} ${vertex.y} ${vertex.z}`);
    }
  }

  lines.push('# Faces');
  for (let i = 0; i < indices.length; i += 3) {
    const a = Number(indices[i]) + 1;
    const b = Number(indices[i + 1]) + 1;
    const c = Number(indices[i + 2]) + 1;
    lines.push(`f ${a} ${b} ${c}`);
  }

  return `${lines.join('\n')}\n`;
}

// Store active sessions
const activeSessions = new Map();

function clearSessionTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function getSessionStatusPayload(session) {
  if (!session) {
    return null;
  }
  const now = Date.now();
  const cycleDuration = session.status === 'sculpt' ? SCULPT_DURATION_MS : BREAK_DURATION_MS;
  const elapsed = now - session.cycleStart;
  const timeRemainingMs = Math.max(cycleDuration - elapsed, 0);
  return {
    status: session.status,
    timeRemainingMs,
    sculptDurationMs: SCULPT_DURATION_MS,
    breakDurationMs: BREAK_DURATION_MS
  };
}

function broadcastSessionStatus(sessionId) {
  const session = activeSessions.get(sessionId);
  const payload = getSessionStatusPayload(session);
  if (!payload) {
    return;
  }
  io.to(sessionId).emit('session-status', payload);
}

function sendSessionStatusToSocket(sessionId, socket) {
  const session = activeSessions.get(sessionId);
  const payload = getSessionStatusPayload(session);
  if (!payload) {
    return;
  }
  socket.emit('session-status', payload);
}

function checkAndHandleCycleTransition(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  const cycleDuration = session.status === 'sculpt' ? SCULPT_DURATION_MS : BREAK_DURATION_MS;
  const elapsed = Date.now() - session.cycleStart;

  if (elapsed >= cycleDuration) {
    if (session.status === 'sculpt') {
      startBreak(sessionId);
    } else {
      resetSessionForNextCycle(sessionId).catch((error) => {
        console.error('Error resetting session for next cycle:', error);
      });
    }
    return true;
  }

  return false;
}

function scheduleCycleTransition(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  clearSessionTimer(session);

  if (checkAndHandleCycleTransition(sessionId)) {
    return;
  }

  const cycleDuration = session.status === 'sculpt' ? SCULPT_DURATION_MS : BREAK_DURATION_MS;
  const elapsed = Date.now() - session.cycleStart;
  const remaining = Math.max(cycleDuration - elapsed, 0);

  session.timer = setTimeout(() => {
    const currentSession = activeSessions.get(sessionId);
    if (!currentSession) {
      return;
    }

    if (currentSession.status === 'sculpt') {
      startBreak(sessionId);
    } else {
      resetSessionForNextCycle(sessionId).catch((error) => {
        console.error('Error resetting session for next cycle:', error);
      });
    }
  }, remaining);
}

function startBreak(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  clearSessionTimer(session);
  session.status = 'break';
  session.cycleStart = Date.now();
  session.dbCleared = session.dbCleared ?? false;

  broadcastSessionStatus(sessionId);
  scheduleCycleTransition(sessionId);
}

async function resetSessionForNextCycle(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  clearSessionTimer(session);

  const defaultState = createDefaultClay();
  session.clayState = defaultState;
  session.lastSave = Date.now();
  session.status = 'sculpt';
  session.cycleStart = Date.now();
  session.dbCleared = false;

  try {
    await pool.query('DELETE FROM clay_sessions WHERE session_id = $1', [sessionId]);
    await updateClayState(sessionId, defaultState);
  } catch (error) {
    console.error('Error updating clay state during cycle reset:', error);
  }

  io.to(sessionId).emit('clay-state', defaultState);
  broadcastSessionStatus(sessionId);
  scheduleCycleTransition(sessionId);
}

function ensureSessionEntry(sessionId, clayState) {
  let session = activeSessions.get(sessionId);

  if (!session) {
    session = {
      clayState,
      lastSave: Date.now(),
      status: 'sculpt',
      cycleStart: Date.now(),
      timer: null,
      dbCleared: false
    };
    activeSessions.set(sessionId, session);
    broadcastSessionStatus(sessionId);
  } else {
    session.clayState = clayState;
    if (!session.status) {
      session.status = 'sculpt';
      session.cycleStart = Date.now();
    }
    if (!session.lastSave) {
      session.lastSave = Date.now();
    }
    if (session.dbCleared === undefined) {
      session.dbCleared = false;
    }
  }

  checkAndHandleCycleTransition(sessionId);
  scheduleCycleTransition(sessionId);

  return session;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-session', async (sessionId) => {
    socket.join(sessionId);
    
    // Load clay state from database
    let session = activeSessions.get(sessionId);
    let clayState;
    if (session) {
      clayState = session.clayState;
    } else {
      clayState = await getClayState(sessionId);
    }
    
    session = ensureSessionEntry(sessionId, clayState);
    
    // Send current state to the new user
    socket.emit('clay-state', session.clayState);
    sendSessionStatusToSocket(sessionId, socket);
    
    // Notify others in the session
    socket.to(sessionId).emit('user-joined', socket.id);
    
    console.log(`User ${socket.id} joined session ${sessionId}`);
  });
  
  socket.on('sculpt-change', async (data) => {
    const { sessionId, vertexIndex, position } = data;
    
    if (!sessionId || vertexIndex === undefined || !position) {
      return;
    }

    if (!activeSessions.has(sessionId)) {
      return;
    }

    if (checkAndHandleCycleTransition(sessionId)) {
      sendSessionStatusToSocket(sessionId, socket);
      return;
    }
    
    const session = activeSessions.get(sessionId);
    if (!session || session.status === 'break') {
      sendSessionStatusToSocket(sessionId, socket);
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

    if (!activeSessions.has(sessionId)) {
      return;
    }

    if (checkAndHandleCycleTransition(sessionId)) {
      sendSessionStatusToSocket(sessionId, socket);
      return;
    }
    
    const session = activeSessions.get(sessionId);
    if (!session || session.status === 'break') {
      sendSessionStatusToSocket(sessionId, socket);
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
    
    // Update active session state and cycle
    const session = activeSessions.get(sessionId);
    if (session) {
      clearSessionTimer(session);
      session.clayState = defaultState;
      session.lastSave = Date.now();
      session.status = 'sculpt';
      session.cycleStart = Date.now();
      broadcastSessionStatus(sessionId);
      scheduleCycleTransition(sessionId);
    } else {
      activeSessions.set(sessionId, {
        clayState: defaultState,
        lastSave: Date.now(),
        status: 'sculpt',
        cycleStart: Date.now(),
        timer: null
      });
      broadcastSessionStatus(sessionId);
      scheduleCycleTransition(sessionId);
    }
    
    // Broadcast reset to all users in the session
    io.to(sessionId).emit('clay-state', defaultState);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting session:', error);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// API endpoint to download current session clay data (only during break)
app.get('/api/session/:sessionId/download', async (req, res) => {
  try {
    const { sessionId } = req.params;
    let session = activeSessions.get(sessionId);

    if (!session) {
      // Attempt to load from database if not in memory
      const clayState = await getClayState(sessionId);
      session = ensureSessionEntry(sessionId, clayState);
    }

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'break') {
      return res.status(400).json({ error: 'Model can only be downloaded during the break period' });
    }

    const filenameTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const objData = clayStateToOBJ(session.clayState ?? createDefaultClay());

    if (!session.dbCleared) {
      try {
        await pool.query('DELETE FROM clay_sessions WHERE session_id = $1', [sessionId]);
        session.dbCleared = true;
      } catch (error) {
        console.error('Error wiping clay state from database:', error);
        // Proceed with download even if deletion fails
      }
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="sculpt-${sessionId}-${filenameTimestamp}.obj"`);
    res.send(objData);
  } catch (error) {
    console.error('Error downloading session clay data:', error);
    res.status(500).json({ error: 'Failed to download sculpt' });
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

