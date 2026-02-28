require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// Add a simple GET route for health checks / browser visits
app.get('/', (req, res) => {
  res.send('Infinite Canvas WebSocket Backend is running!');
});

// Ping route for free server uptime monitoring (e.g. UptimeRobot)
app.get('/ping', (req, res) => {
  res.send('Awake!');
});

const server = http.createServer(app);

// Graceful shutdown flag
let isShuttingDown = false;

// Configuration for WebSocket limits
const io = new Server(server, {
  maxHttpBufferSize: 5e7, // 50MB payload limit
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware: Pause new socket connections instantly if shutting down
io.use((socket, next) => {
  if (isShuttingDown) {
    return next(new Error('Server is shutting down'));
  }
  next();
});

// Mongoose schema: One single source of truth document
const canvasSchema = new mongoose.Schema({
  canvasId: { type: String, required: true, unique: true },
  elements: { type: mongoose.Schema.Types.Mixed, default: [] },
  canvasBg: { type: String, default: '#e5e5f7' }
});

const CanvasState = mongoose.model('CanvasState', canvasSchema);

// In-memory global state
// Requirement 1: Flat Array of lightweight JSON vector objects natively tracking infinite pos
let elements = [];
let canvasBg = '#e5e5f7';
const CANVAS_DOC_ID = 'main-infinity-canvas';

// Helper to push pure JSON to Mongoose document bypassing heavy memory cloning
async function saveStateToDB() {
  try {
    console.log('Saving global memory array to database...');
    // Overwrite the single document array
    await CanvasState.findOneAndUpdate(
      { canvasId: CANVAS_DOC_ID },
      { elements, canvasBg },
      { upsert: true, new: true }
    );
    console.log('Canvas state saved successfully.');
  } catch (err) {
    console.error('Failed to sync state to database:', err);
  }
}

async function initializeServer() {
  try {
    const mongoURI = process.env.MONGO_URI;

    // Requirement 2: Connect DB and Load to RAM before Socket.io starts listening
    if (mongoURI) {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(mongoURI);
      console.log('Database connected.');

      // Fetch the single source of truth document
      const doc = await CanvasState.findOne({ canvasId: CANVAS_DOC_ID }).lean();

      if (doc) {
        elements = doc.elements || [];
        canvasBg = doc.canvasBg || '#e5e5f7';
        console.log(`Loaded ${elements.length} elements from primary canvas document.`);
      } else {
        console.log('No existing state found, a new global state document will be created.');
        await saveStateToDB();
      }
    } else {
      console.warn("WARNING: MONGO_URI is missing in environment variables.");
      console.warn("Server is skipping DB initialization and running entirely in RAM (No persistence).");
    }

    // Handle WebSocket interactions
    io.on('connection', (socket) => {
      console.log(`User connected: ${socket.id}. Active connections: ${io.engine.clientsCount}`);

      // Sync the client with the full RAM array that was loaded from DB
      socket.emit('init_elements', elements);
      socket.emit('init_bg', canvasBg);

      socket.on('add_element', (element) => {
        // Find existing to overwrite it
        const index = elements.findIndex(e => e.id === element.id);
        if (index !== -1) {
          elements[index] = element;
        } else {
          elements.push(element);
        }

        socket.broadcast.emit('element_added', element);
      });

      socket.on('change_bg', (newBg) => {
        canvasBg = newBg;
        io.emit('bg_changed', canvasBg);
      });

      socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}. Active connections: ${io.engine.clientsCount}`);
      });
    });

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      console.log(`WebSocket Server is listening on port ${PORT}`);

      // Requirement 2: Periodic Auto-Save
      if (mongoURI) {
        // Runs every 3 minutes
        setInterval(() => {
          if (!isShuttingDown) saveStateToDB();
        }, 180000);
      }

      // Built-in automated self-ping every 5 minutes to keep Render alive natively
      const pingUrl = process.env.PING_URL || 'https://webtigo-canvas-server.onrender.com/ping';
      setInterval(() => {
        if (!isShuttingDown) {
          require('https').get(pingUrl, (res) => {
            console.log('Automated self-ping successful to keep server awake. Status:', res.statusCode);
          }).on('error', (e) => {
            console.error('Automated self-ping failed:', e.message);
          });
        }
      }, 300000); // 5 minutes (300,000 milliseconds)

    });

  } catch (err) {
    console.error('Failed to boot server due to database connection error:', err);
    process.exit(1);
  }
}

// Boot Sequence
initializeServer();

// Requirement 2: Graceful Shutdown (Emergency Save)
async function handleShutdown(signal) {
  if (isShuttingDown) return;
  console.log(`\nReceived ${signal}. Capturing final state...`);
  isShuttingDown = true;

  if (process.env.MONGO_URI && mongoose.connection.readyState === 1) {
    console.log('Executing final database persistence save...');
    await saveStateToDB();
    await mongoose.connection.close(false);
    console.log('Database connections successfully disconnected.');
  }

  io.close(() => {
    console.log('Paused and closed all WebSocket connections.');
    server.close(() => {
      console.log('HTTP Express listener stopped. Exiting cleanly.');
      process.exit(0);
    });
  });

  // Host environmental hard timeout fallback
  setTimeout(() => {
    console.error('Graceful shutdown took too long. Force killing process.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
