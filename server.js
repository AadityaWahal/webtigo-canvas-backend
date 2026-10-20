require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);

// ---------------------------------------------------------
// Global State & Persistent Store
// ---------------------------------------------------------
let connectedUsers = 0;
let canvasElements = []; // Stores strokes, shapes, and fills
let canvasBg = '#0a0c10'; // Default dark obsidian canvas background

// ---------------------------------------------------------
// Optional MongoDB Integration (preserves env variable)
// ---------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI;

// Optional Mongoose Schema for persistent elements
const ElementSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  type: { type: String, required: true }, // 'brush' | 'shape' | 'fill'
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now }
});
const CanvasElementModel = mongoose.models.CanvasElement || mongoose.model('CanvasElement', ElementSchema);

if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      console.log(' Connected to MongoDB (Endlessync Database)');
      try {
        // Load existing elements from MongoDB if available
        const saved = await CanvasElementModel.find({}).sort({ createdAt: 1 }).lean();
        if (saved && saved.length > 0) {
          canvasElements = saved.map(item => item.data);
          console.log(` Loaded ${canvasElements.length} elements from MongoDB.`);
        }
      } catch (err) {
        console.warn('⚠️ Could not load initial state from MongoDB:', err.message);
      }
    })
    .catch((err) => console.error('❌ MongoDB connection error:', err.message));
} else {
  console.log('ℹ️ Running in fast in-memory mode (MONGO_URI not configured)');
}

// Helper to persist elements to Mongo asynchronously
async function persistElementToDb(element) {
  if (mongoose.connection.readyState !== 1 || !element || !element.id) return;
  try {
    await CanvasElementModel.findOneAndUpdate(
      { id: element.id },
      { id: element.id, type: element.type || 'element', data: element },
      { upsert: true }
    );
  } catch (err) {
    console.error('Mongo persist error:', err.message);
  }
}

async function removeElementFromDb(elementId) {
  if (mongoose.connection.readyState !== 1 || !elementId) return;
  try {
    await CanvasElementModel.deleteOne({ id: elementId });
  } catch (err) {
    console.error('Mongo delete error:', err.message);
  }
}

async function clearDbElements() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await CanvasElementModel.deleteMany({});
  } catch (err) {
    console.error('Mongo clear error:', err.message);
  }
}

// ---------------------------------------------------------
// Express Routes & Keep-Awake Endpoints for Render 24/7
// ---------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    appName: 'Endlessync Server',
    connectedUsers,
    totalElements: canvasElements.length,
    mongoConnected: mongoose.connection.readyState === 1,
    uptime: `${Math.round(process.uptime())}s`,
    timestamp: new Date().toISOString(),
  });
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// REST endpoint to get current canvas elements
app.get('/api/elements', (req, res) => {
  res.json({ elements: canvasElements, count: canvasElements.length });
});

// ---------------------------------------------------------
// Real-Time Socket.io Connection & Synchronization
// ---------------------------------------------------------
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`[+] User connected: ${socket.id} (Total Online: ${connectedUsers})`);

  // 1. Send initial canvas state and status to newly connected client
  socket.emit('endlessync:init', {
    socketId: socket.id,
    elements: canvasElements,
    bg: canvasBg,
    onlineUsers: connectedUsers,
    serverTime: new Date().toISOString()
  });

  // Broadcast updated user count
  io.emit('endlessync:users_count', { onlineUsers: connectedUsers });

  // 2. Ping-pong latency check
  socket.on('endlessync:ping', (callback) => {
    if (typeof callback === 'function') {
      callback({ serverTime: Date.now() });
    }
  });

  // 3. Add or update drawing element (stroke, shape, fill)
  socket.on('element:add', (element) => {
    if (!element || !element.id) return;
    
    // Update local memory
    const existingIndex = canvasElements.findIndex((el) => el.id === element.id);
    if (existingIndex !== -1) {
      canvasElements[existingIndex] = element;
    } else {
      canvasElements.push(element);
    }

    // Broadcast to all other connected clients
    socket.broadcast.emit('element:added', element);

    // Save to DB in background
    persistElementToDb(element);
  });

  // 4. Batch sync for smooth high-frequency freehand strokes
  socket.on('element:batch_add', (elements) => {
    if (!Array.isArray(elements) || elements.length === 0) return;
    elements.forEach(el => {
      const idx = canvasElements.findIndex(e => e.id === el.id);
      if (idx !== -1) canvasElements[idx] = el;
      else canvasElements.push(el);
      persistElementToDb(el);
    });
    socket.broadcast.emit('element:batch_added', elements);
  });

  // 5. Erase element by ID
  socket.on('element:erase', (elementId) => {
    if (!elementId) return;
    canvasElements = canvasElements.filter((el) => el.id !== elementId);
    socket.broadcast.emit('element:erased', elementId);
    removeElementFromDb(elementId);
  });

  // 6. Clear entire board
  socket.on('canvas:clear', () => {
    canvasElements = [];
    io.emit('canvas:cleared');
    clearDbElements();
  });

  // 7. Optional peer cursor sharing
  socket.on('cursor:move', (data) => {
    if (!data) return;
    socket.broadcast.emit('cursor:moved', {
      id: socket.id,
      x: data.x,
      y: data.y,
    });
  });

  // 8. Disconnect
  socket.on('disconnect', () => {
    connectedUsers = Math.max(0, connectedUsers - 1);
    console.log(`[-] User disconnected: ${socket.id} (Total Online: ${connectedUsers})`);
    io.emit('endlessync:users_count', { onlineUsers: connectedUsers });
    socket.broadcast.emit('cursor:disconnected', socket.id);
  });
});

// ---------------------------------------------------------
// Startup & Render 24/7 Keep-Alive Auto-Ping
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Endlessync Server active on port ${PORT}`);

  // Automated self-ping every 4 minutes (240,000 ms) to keep Render awake 24/7
  const pingUrl =
    process.env.PING_URL ||
    (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : null);

  if (pingUrl) {
    console.log(` Keep-awake auto-ping scheduled for: ${pingUrl}`);
    const client = pingUrl.startsWith('https') ? require('https') : require('http');

    setInterval(() => {
      client
        .get(pingUrl, (res) => {
          console.log(`[Keep-Awake] Auto-ping status ${res.statusCode} at ${new Date().toLocaleTimeString()}`);
        })
        .on('error', (err) => {
          console.warn(`[Keep-Awake] Auto-ping failed: ${err.message}`);
        });
    }, 240000); // 4 minutes
  } else {
    console.log('ℹ️ Keep-awake self-ping waiting for PING_URL or RENDER_EXTERNAL_URL');
  }
});
