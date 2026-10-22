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
// Ultra-Lightweight Global State (Optimized for 24/7 Render)
// ---------------------------------------------------------
let connectedUsers = 0;
let canvasElements = []; // In-memory cache
const MAX_STORED_ELEMENTS = 2500; // Cap to prevent memory leaks on free tier
let pendingDbSaves = new Map(); // Debounced save queue

// ---------------------------------------------------------
// Optional MongoDB Persistence (Preserves process.env.MONGO_URI)
// ---------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI;

const ElementSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
});
const CanvasElementModel =
  mongoose.models.CanvasElement || mongoose.model('CanvasElement', ElementSchema);

if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      console.log(' Connected to MongoDB (Endlessync Database)');
      try {
        const saved = await CanvasElementModel.find({})
          .sort({ updatedAt: 1 })
          .limit(MAX_STORED_ELEMENTS)
          .lean();
        if (saved && saved.length > 0) {
          canvasElements = saved.map((item) => item.data);
          console.log(` Loaded ${canvasElements.length} elements from MongoDB.`);
        }
      } catch (err) {
        console.warn('⚠️ Could not load initial state from DB:', err.message);
      }
    })
    .catch((err) => console.error('❌ MongoDB connection error:', err.message));
} else {
  console.log('ℹ️ Running in ultra-fast in-memory mode (MONGO_URI not configured)');
}

// Low-overhead background flusher for MongoDB (runs every 10s only if dirty)
setInterval(async () => {
  if (mongoose.connection.readyState !== 1 || pendingDbSaves.size === 0) return;
  const toSave = Array.from(pendingDbSaves.values());
  pendingDbSaves.clear();

  try {
    const ops = toSave.map((el) => ({
      updateOne: {
        filter: { id: el.id },
        update: { $set: { id: el.id, data: el, updatedAt: new Date() } },
        upsert: true,
      },
    }));
    await CanvasElementModel.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.warn('⚠️ Background DB flush error:', err.message);
  }
}, 10000);

// ---------------------------------------------------------
// Featherweight HTTP Endpoints for Render 24/7 Keep-Alive
// ---------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    appName: 'Endlessync Server',
    connectedUsers,
    totalElements: canvasElements.length,
    memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptime: `${Math.round(process.uptime())}s`,
    timestamp: new Date().toISOString(),
  });
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// ---------------------------------------------------------
// WebSocket Synchronization (Frontend does the heavy lifting)
// ---------------------------------------------------------
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7, // 10MB limit for rich media attachments
});

io.on('connection', (socket) => {
  connectedUsers++;

  // Send current board state to new user
  socket.emit('endlessync:init', {
    socketId: socket.id,
    elements: canvasElements,
    onlineUsers: connectedUsers,
  });

  io.emit('endlessync:users_count', { onlineUsers: connectedUsers });

  // Latency check
  socket.on('endlessync:ping', (callback) => {
    if (typeof callback === 'function') callback({ serverTime: Date.now() });
  });

  // Client adds a new element (stroke, shape, fill)
  socket.on('element:add', (element) => {
    if (!element || !element.id) return;

    // Cache locally & cap memory
    const existingIndex = canvasElements.findIndex((el) => el.id === element.id);
    if (existingIndex !== -1) {
      canvasElements[existingIndex] = element;
    } else {
      if (canvasElements.length >= MAX_STORED_ELEMENTS) {
        canvasElements.shift(); // Evict oldest
      }
      canvasElements.push(element);
    }

    // Broadcast immediately to peers
    socket.broadcast.emit('element:added', element);

    // Queue for low-overhead async database save
    if (MONGO_URI) {
      pendingDbSaves.set(element.id, element);
    }
  });

  // Client erases an element
  socket.on('element:erase', (elementId) => {
    if (!elementId) return;
    canvasElements = canvasElements.filter((el) => el.id !== elementId);
    socket.broadcast.emit('element:erased', elementId);

    if (MONGO_URI) {
      pendingDbSaves.delete(elementId);
      CanvasElementModel.deleteOne({ id: elementId }).catch(() => {});
    }
  });

  // Client clears the canvas board (preserves server state, empties elements)
  socket.on('canvas:clear', () => {
    canvasElements = [];
    pendingDbSaves.clear();
    io.emit('canvas:cleared');

    if (MONGO_URI) {
      CanvasElementModel.deleteMany({}).catch((err) => {
        console.warn('⚠️ Canvas clear DB error:', err.message);
      });
    }
    console.log(`🧹 Canvas board cleared by client ${socket.id}`);
  });

  socket.on('disconnect', () => {
    connectedUsers = Math.max(0, connectedUsers - 1);
    io.emit('endlessync:users_count', { onlineUsers: connectedUsers });
  });
});

// ---------------------------------------------------------
// Startup & Render Keep-Alive Auto-Ping
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Endlessync Server active on port ${PORT}`);

  const pingUrl =
    process.env.PING_URL ||
    (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : null);

  if (pingUrl) {
    console.log(` Keep-awake auto-ping scheduled for: ${pingUrl}`);
    const client = pingUrl.startsWith('https') ? require('https') : require('http');

    setInterval(() => {
      client
        .get(pingUrl, (res) => {
          // Keep response lightweight
        })
        .on('error', () => {});
    }, 240000); // 4 minutes
  }
});
