const db = require('./db');

module.exports = function (io) {
  const onlineUsers = new Map(); // userId -> socketId
  const voiceRooms = new Map(); // channelId -> Set of userIds

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const userId = session?.userId;

    if (!userId) return socket.disconnect();

    onlineUsers.set(userId, socket.id);
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
    io.emit('user-online', userId);

    // Channel chat
    socket.on('join-channel', (channelId) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on('leave-channel', (channelId) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on('send-message', (data) => {
      const { channelId, content } = data;
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      db.prepare('INSERT INTO messages (id, channel_id, sender_id, content) VALUES (?, ?, ?, ?)').run(id, channelId, userId, content);
      const msg = db.prepare('SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(id);
      io.to(`channel:${channelId}`).emit('new-message', msg);
    });

    socket.on('typing', (data) => {
      const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
      socket.to(`channel:${data.channelId}`).emit('user-typing', { username: user.username, channelId: data.channelId });
    });

    // Direct messages
    socket.on('send-dm', (data) => {
      const { receiverId, content } = data;
      console.log(`[Socket] send-dm from ${userId} to ${receiverId}`);
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      db.prepare('INSERT INTO direct_messages (id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)').run(id, userId, receiverId, content);
      const msg = db.prepare('SELECT dm.*, u.username, u.avatar FROM direct_messages dm JOIN users u ON u.id = dm.sender_id WHERE dm.id = ?').get(id);

      // Send to both sender and receiver
      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit('new-dm', msg);
      } else {
        console.log(`[Socket] Receiver ${receiverId} not online`);
      }
      socket.emit('new-dm', msg);
    });

    // Voice (WebRTC signaling)
    socket.on('join-voice', (channelId) => {
      if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Set());
      const room = voiceRooms.get(channelId);
      const user = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(userId);

      // Notify existing users in the room ONLY
      for (const peerId of room) {
        const peerSocket = onlineUsers.get(peerId);
        if (peerSocket) {
          io.to(peerSocket).emit('voice-user-joined', { userId, username: user.username, channelId });
        }
      }

      // Send existing users to new joiner
      const userList = Array.from(room);
      let existingUsers = [];
      if (userList.length > 0) {
        const placeholders = userList.map(() => '?').join(',');
        existingUsers = db.prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`).all(...userList);
      }
      socket.emit('voice-room-users', { channelId, users: existingUsers });

      room.add(userId);
      socket.join(`voice:${channelId}`);

      // Broadcast room update to room members and for the sidebar
      const allMembers = Array.from(room);
      const placeholders = allMembers.map(() => '?').join(',');
      const fullRoomUsers = db.prepare(`SELECT id, username, avatar FROM users WHERE id IN (${placeholders})`).all(...allMembers);
      
      io.to(`voice:${channelId}`).emit('voice-room-update', { channelId, users: fullRoomUsers });
      // Also emit globally for sidebar synchronization, but maybe throttle this in the future if too many rooms
      io.emit('voice-room-update', { channelId, users: fullRoomUsers });
    });

    socket.on('leave-voice', (channelId) => {
      const room = voiceRooms.get(channelId);
      if (room) {
        room.delete(userId);
        socket.leave(`voice:${channelId}`);
        io.to(`voice:${channelId}`).emit('voice-user-left', { userId, channelId });

        const allMembers = Array.from(room);
        let fullRoomUsers = [];
        if (allMembers.length > 0) {
          const placeholders = allMembers.map(() => '?').join(',');
          fullRoomUsers = db.prepare(`SELECT id, username, avatar FROM users WHERE id IN (${placeholders})`).all(...allMembers);
        }

        io.to(`voice:${channelId}`).emit('voice-room-update', { channelId, users: fullRoomUsers });
        io.emit('voice-room-update', { channelId, users: fullRoomUsers });

        if (room.size === 0) voiceRooms.delete(channelId);
      }
    });

    socket.on('offer', (data) => {
      const peerSocket = onlineUsers.get(data.to);
      if (peerSocket) io.to(peerSocket).emit('offer', { from: userId, offer: data.offer, channelId: data.channelId });
    });

    socket.on('answer', (data) => {
      const peerSocket = onlineUsers.get(data.to);
      if (peerSocket) io.to(peerSocket).emit('answer', { from: userId, answer: data.answer });
    });

    socket.on('candidate', (data) => {
      const peerSocket = onlineUsers.get(data.to);
      if (peerSocket) io.to(peerSocket).emit('candidate', { from: userId, candidate: data.candidate });
    });

    // Direct Call Signaling
    socket.on('call-user', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      const caller = db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(userId);
      if (targetSocket) {
        io.to(targetSocket).emit('incoming-call', {
          from: userId,
          callerName: caller.username,
          callerAvatar: caller.avatar,
          signal: data.signal, // Initial Offer
          withVideo: data.withVideo
        });
      }
    });

    socket.on('answer-call', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('call-accepted', { from: userId, signal: data.signal });
    });

    socket.on('reject-call', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('call-rejected', { from: userId });
    });

    // ICE Candidates for Direct Call
    socket.on('call-ice-candidate', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('call-ice-candidate', { from: userId, candidate: data.candidate });
    });

    // End Call
    socket.on('end-call', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('call-ended', { from: userId });
    });

    // Screen Share Signaling
    socket.on('screen-share-started', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('screen-share-started', { from: userId });
    });

    socket.on('screen-share-stopped', (data) => {
      const targetSocket = onlineUsers.get(data.to);
      if (targetSocket) io.to(targetSocket).emit('screen-share-stopped', { from: userId });
    });


    socket.on('get-voice-states', () => {
      const allStates = {};
      for (const [channelId, room] of voiceRooms.entries()) {
        const userList = Array.from(room);
        if (userList.length > 0) {
          const placeholders = userList.map(() => '?').join(',');
          allStates[channelId] = db.prepare(`SELECT id, username, avatar FROM users WHERE id IN (${placeholders})`).all(...userList);
        } else {
          allStates[channelId] = [];
        }
      }
      socket.emit('voice-states-sync', allStates);
    });

    // Friend request notification
    socket.on('friend-request-sent', (data) => {
      const targetSocket = onlineUsers.get(data.targetUserId);
      if (targetSocket) io.to(targetSocket).emit('friend-request-received');
    });

    socket.on('friend-accepted', (data) => {
      const targetSocket = onlineUsers.get(data.targetUserId);
      if (targetSocket) io.to(targetSocket).emit('friend-accepted-sync');
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(userId);
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
      io.emit('user-offline', userId);

      // Remove from voice rooms
      for (const [channelId, room] of voiceRooms.entries()) {
        if (room.has(userId)) {
          room.delete(userId);
          socket.leave(`voice:${channelId}`);
          io.to(`voice:${channelId}`).emit('voice-user-left', { userId, channelId });

          const allMembers = Array.from(room);
          let fullRoomUsers = [];
          if (allMembers.length > 0) {
            const placeholders = allMembers.map(() => '?').join(',');
            fullRoomUsers = db.prepare(`SELECT id, username, avatar FROM users WHERE id IN (${placeholders})`).all(...allMembers);
          }

          io.to(`voice:${channelId}`).emit('voice-room-update', { channelId, users: fullRoomUsers });
          io.emit('voice-room-update', { channelId, users: fullRoomUsers });

          if (room.size === 0) voiceRooms.delete(channelId);
        }
      }
    });
  });
};
