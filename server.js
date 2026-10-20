const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

const server = http.createServer(app);

// In-memory persistent canvas elements (drawings, text, voice notes, shapes, images)
let canvasElements = [];
let canvasBg = '#090a0f'; // Default dark space
let connectedUsers = 0;

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Ping endpoint for keep-awake monitors
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    appName: 'Webtigo Infinity Multiplayer Server',
    connectedUsers,
    totalElements: canvasElements.length,
    uptime: Math.round(process.uptime()) + 's'
  });
});

// Ping route for free server uptime monitoring (e.g. UptimeRobot or self-ping)
app.get('/ping', (req, res) => {
  res.send('Awake!');
});

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`[+] User connected: ${socket.id} (Online: ${connectedUsers})`);

  // 1. Send all existing drawings, shapes, and notes to newly joined user
  socket.emit('init_elements', canvasElements);
  socket.emit('init_bg', canvasBg);

  // 2. Real-time Multiplayer Spaceship Cursors:
  // Broadcasts user's spaceship coordinates to everyone else on canvas
  socket.on('cursor_move', (data) => {
    if (!data) return;
    socket.broadcast.emit('user_cursor', {
      id: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle || 0,
    });
  });

  // 3. User adds or updates an element (line, text, audio note, shape, image)
  socket.on('add_element', (newElement) => {
    if (!newElement || !newElement.id) return;
    const index = canvasElements.findIndex(el => el.id === newElement.id);
    if (index !== -1) {
      canvasElements[index] = newElement;
    } else {
      canvasElements.push(newElement);
    }
    socket.broadcast.emit('element_added', newElement);
  });

  // 4. User deletes an element
  socket.on('delete_element', (elementId) => {
    if (!elementId) return;
    canvasElements = canvasElements.filter(el => el.id !== elementId);
    socket.broadcast.emit('element_deleted', elementId);
  });

  // 5. Sky background changed
  socket.on('change_bg', (newBgColor) => {
    canvasBg = newBgColor;
    io.emit('bg_changed', newBgColor);
  });

  // 6. Clear canvas
  socket.on('clear_canvas', () => {
    canvasElements = [];
    io.emit('canvas_cleared');
  });

  // 7. Disconnection
  socket.on('disconnect', () => {
    connectedUsers = Math.max(0, connectedUsers - 1);
    socket.broadcast.emit('user_disconnected', socket.id);
  });
});

// Render automatically injects PORT via process.env.PORT; defaults to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Webtigo Infinity Server running on port ${PORT}`);

  // Built-in automated self-ping every 4 minutes to keep Render alive natively
  const pingUrl = process.env.PING_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : 'https://webtigo-canvas-server.onrender.com/ping');
  const pingClient = pingUrl.startsWith('https') ? require('https') : require('http');

  setInterval(() => {
    pingClient.get(pingUrl, (res) => {
      console.log('Automated self-ping successful to keep server awake. Status:', res.statusCode);
    }).on('error', (e) => {
      console.error('Automated self-ping failed:', e.message);
    });
  }, 240000); // 4 minutes (240,000 milliseconds)
});
