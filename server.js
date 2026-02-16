// Railway Deployment Trigger: 2026-02-16
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();

const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');
// Railway provides the PORT environment variable. Often we want HTTP in production.
const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL;
const hasCertificates = !isRailway && fs.existsSync(keyPath) && fs.existsSync(certPath);

let server;
let protocol = 'http';

if (hasCertificates) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, app);
  protocol = 'https';
  console.log('SSL certificates found. Using HTTPS.');
} else {
  server = http.createServer(app);
  protocol = 'http';
  console.log('SSL certificates not found or incomplete. Falling back to HTTP.');
}

const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './' }),
  secret: 'owndc-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server);
io.engine.use(sessionMiddleware);
app.set('io', io);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/users', require('./routes/users'));
app.use('/api/livekit', require('./routes/livekit'));

// Socket.IO
require('./socket')(io);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  console.log(`OwnDC server running on:`);
  console.log(`- Local:   ${protocol}://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`- Network: ${protocol}://${addr}:${PORT}`));
});
