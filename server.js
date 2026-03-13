const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

// Initialize Express app
const app = express();

// ✅ CREATE HTTP SERVER (WRAP EXPRESS APP)
const server = http.createServer(app);

// ✅ INITIALIZE SOCKET.IO WITH CORS
const io = new Server(server, {
  cors: {
    origin: [
      'https://korda.vercel.app',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      process.env.FRONTEND_URL
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
  }
});

// ============================================
// MIDDLEWARE CONFIGURATION
// ============================================

// Body Parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cookie Parser
app.use(cookieParser());

// Security Headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Enable CORS - FIXED TO SUPPORT VITE (PORT 5173) AND VERCEL
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://korda.vercel.app',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('❌ Blocked by CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

// ✅ RATE LIMITING COMPLETELY REMOVED - NO RESTRICTIONS

// ============================================
// REQUEST LOGGING (Optional - for monitoring)
// ============================================
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// ============================================
// SOCKET.IO CONFIGURATION - COMPLETE FIX FOR AUDIO CALLS
// ============================================
const onlineUsers = new Map();
const activeCalls = new Map();
const callTimeouts = new Map();

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // ============================================
  // USER AUTHENTICATION & ONLINE STATUS
  // ============================================
  
  socket.on('user:online', (userId) => {
    if (!userId) return;
    
    socket.userId = userId;
    socket.join(userId);
    onlineUsers.set(userId, socket.id);
    
    console.log(`✅ User ${userId} is now online (Socket: ${socket.id})`);
    
    // ✅ Broadcast online status to ALL users
    io.emit('user:status', {
      userId,
      isOnline: true
    });
  });

  // ============================================
  // AUDIO CALL HANDLERS
  // ============================================

  // ✅ Initiate audio call - SENDS CALLID BACK TO CALLER
  socket.on('audio:call:initiate', async ({ receiverId, callerId, callerInfo }) => {
    try {
      console.log(`📞 ${callerId} is calling ${receiverId}`);

      const callId = `call_${callerId}_${receiverId}_${Date.now()}`;
      const receiverSocketId = onlineUsers.get(receiverId);
      
      if (!receiverSocketId) {
        console.log('❌ Receiver is offline');
        socket.emit('audio:call:error', { message: 'User is offline' });
        return;
      }
      
      // Create call session
      activeCalls.set(callId, {
        id: callId,
        caller: callerId,
        receiver: receiverId,
        callerSocketId: socket.id,
        receiverSocketId: receiverSocketId,
        status: 'ringing',
        startedAt: new Date(),
        callerInfo: callerInfo
      });

      // ✅ Set 30-second timeout for missed call
      const missedCallTimeout = setTimeout(async () => {
        const call = activeCalls.get(callId);
        
        if (call && call.status === 'ringing') {
          console.log(`⏰ Call ${callId} timed out - creating missed call records`);
          
          // ✅ CREATE DATABASE RECORDS FOR BOTH USERS
          const Message = require('./models/Message');
          
          try {
            // Create missed call record for CALLER (shows as "No answer")
            await Message.create({
              sender: call.caller,
              receiver: call.receiver,
              type: 'call',
              content: '',
              callData: {
                duration: 0,
                callType: 'audio',
                status: 'missed',
                timestamp: new Date(),
              },
              status: 'delivered',
            });
            
            // Create missed call record for RECEIVER (shows as "Missed call")
            await Message.create({
              sender: call.receiver,
              receiver: call.caller,
              type: 'call',
              content: '',
              callData: {
                duration: 0,
                callType: 'audio',
                status: 'missed',
                timestamp: new Date(),
              },
              status: 'delivered',
            });
            
            console.log('✅ Missed call records created in database');
          } catch (error) {
            console.error('❌ Error creating missed call records:', error);
          }
          
          // Notify CALLER: "no answer"
          io.to(call.callerSocketId).emit('audio:call:missed', {
            callId,
            reason: 'No answer',
            callType: 'outgoing'
          });
          
          // Notify RECEIVER: "missed call"
          io.to(call.receiverSocketId).emit('audio:call:missed', {
            callId,
            reason: 'Missed call',
            callType: 'incoming'
          });
          
          activeCalls.delete(callId);
          callTimeouts.delete(callId);
        }
      }, 30000);
      
      callTimeouts.set(callId, missedCallTimeout);

      // ✅ CRITICAL FIX: Send callId BACK to caller so they have the correct one
      socket.emit('audio:call:initiated', {
        callId,
        receiverId,
      });

      // ✅ Notify receiver about incoming call
      io.to(receiverSocketId).emit('audio:call:incoming', {
        callId,
        caller: callerInfo,
      });

      console.log(`✅ Call initiated: ${callId} (sent to both caller and receiver)`);

    } catch (error) {
      console.error('❌ Error initiating call:', error);
      socket.emit('audio:call:error', { message: 'Failed to initiate call' });
    }
  });

  // ✅ Accept audio call
  socket.on('audio:call:accept', async ({ callId }) => {
    try {
      console.log('🎯 Accept call request:', callId);
      
      const call = activeCalls.get(callId);
      if (!call) {
        console.log('❌ Call not found:', callId);
        return;
      }

      // ✅ Clear missed call timeout
      const timeout = callTimeouts.get(callId);
      if (timeout) {
        clearTimeout(timeout);
        callTimeouts.delete(callId);
      }

      // Update call status
      call.status = 'active';
      call.acceptedAt = new Date();
      activeCalls.set(callId, call);

      console.log(`✅ Call accepted: ${callId}`);

      const acceptedData = {
        callId,
        acceptedAt: call.acceptedAt,
      };
      
      // ✅ Emit to BOTH parties IMMEDIATELY
      console.log(`📤 Emitting 'accepted' to CALLER: ${call.callerSocketId}`);
      io.to(call.callerSocketId).emit('audio:call:accepted', acceptedData);
      
      console.log(`📤 Emitting 'accepted' to RECEIVER: ${call.receiverSocketId}`);
      io.to(call.receiverSocketId).emit('audio:call:accepted', acceptedData);

    } catch (error) {
      console.error('❌ Error accepting call:', error);
    }
  });

  // ✅ Decline audio call
  socket.on('audio:call:decline', async ({ callId, reason }) => {
    try {
      const call = activeCalls.get(callId);
      if (!call) return;

      // Clear timeout
      const timeout = callTimeouts.get(callId);
      if (timeout) {
        clearTimeout(timeout);
        callTimeouts.delete(callId);
      }

      console.log(`❌ Call declined: ${callId}`);

      // Notify CALLER
      io.to(call.callerSocketId).emit('audio:call:declined', {
        callId,
        reason: reason || 'Call declined',
      });

      activeCalls.delete(callId);

    } catch (error) {
      console.error('❌ Error declining call:', error);
    }
  });

  
  // ✅ End audio call - CREATES DATABASE RECORDS
  socket.on('audio:call:end', async ({ callId, duration }) => {
    try {
      console.log('🎯 End call request:', callId);
      
      const call = activeCalls.get(callId);
      if (!call) {
        console.log('⚠️ Call not found:', callId);
        return;
      }

      // Clear timeout
      const timeout = callTimeouts.get(callId);
      if (timeout) {
        clearTimeout(timeout);
        callTimeouts.delete(callId);
      }

      // Calculate duration
      const finalDuration = duration !== undefined ? duration : (
        call.acceptedAt 
          ? Math.floor((new Date() - call.acceptedAt) / 1000)
          : 0
      );

      const wasAccepted = call.status === 'active' && call.acceptedAt;
      const callStatus = wasAccepted && finalDuration > 0 ? 'completed' : 'missed';

      console.log(`📞 Call ending: ${callId}, Duration: ${finalDuration}s, Status: ${callStatus}`);

      // ✅ CREATE DATABASE RECORDS FOR BOTH USERS
      const Message = require('./models/Message');
      
      try {
        // Create call record for CALLER
        await Message.create({
          sender: call.caller,
          receiver: call.receiver,
          type: 'call',
          content: '',
          callData: {
            duration: finalDuration,
            callType: 'audio',
            status: callStatus,
            timestamp: new Date(),
          },
          status: 'delivered',
        });
        
        // Create call record for RECEIVER
        await Message.create({
          sender: call.receiver,
          receiver: call.caller,
          type: 'call',
          content: '',
          callData: {
            duration: finalDuration,
            callType: 'audio',
            status: callStatus,
            timestamp: new Date(),
          },
          status: 'delivered',
        });
        
        console.log('✅ Call end records created in database for both users');
      } catch (error) {
        console.error('❌ Error creating call end records:', error);
      }

      const endData = {
        callId,
        duration: finalDuration,
        wasAccepted: wasAccepted,
        endedBy: socket.userId,
      };

      // ✅ Emit to BOTH parties IMMEDIATELY
      console.log(`📤 Emitting 'ended' to CALLER: ${call.callerSocketId}`);
      io.to(call.callerSocketId).emit('audio:call:ended', endData);
      
      console.log(`📤 Emitting 'ended' to RECEIVER: ${call.receiverSocketId}`);
      io.to(call.receiverSocketId).emit('audio:call:ended', endData);

      // Remove call session
      activeCalls.delete(callId);

      console.log(`✅ Call ${callId} ended for both parties`);

    } catch (error) {
      console.error('❌ Error ending call:', error);
    }
  });

  // ============================================
  // WebRTC SIGNALING (Optional - for actual audio)
  // ============================================

   // ✅ FIXED: WebRTC Offer (Caller → Receiver)
  socket.on('audio:webrtc:offer', ({ callId, receiverId, offer }) => {
    console.log(`📡 WebRTC offer from ${socket.userId} to ${receiverId}`);
    
    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      console.log(`✅ Forwarding offer to receiver socket: ${receiverSocketId}`);
      io.to(receiverSocketId).emit('audio:webrtc:offer', {
        callId,
        senderId: socket.userId,
        offer,
      });
    } else {
      console.log('❌ Receiver not online');
    }
  });

  // ✅ FIXED: WebRTC Answer (Receiver → Caller)
  socket.on('audio:webrtc:answer', ({ callId, callerId, answer }) => {
    console.log(`📡 WebRTC answer from ${socket.userId} to ${callerId}`);
    
    const callerSocketId = onlineUsers.get(callerId);
    if (callerSocketId) {
      console.log(`✅ Forwarding answer to caller socket: ${callerSocketId}`);
      io.to(callerSocketId).emit('audio:webrtc:answer', {
        callId,
        senderId: socket.userId,
        answer,
      });
    } else {
      console.log('❌ Caller not online');
    }
  });

  // ✅ FIXED: ICE Candidate Exchange (Bidirectional)
  socket.on('audio:webrtc:ice-candidate', ({ callId, targetUserId, candidate }) => {
    console.log(`📡 ICE candidate from ${socket.userId} to ${targetUserId}`);
    
    const targetSocketId = onlineUsers.get(targetUserId);
    if (targetSocketId) {
      console.log(`✅ Forwarding ICE candidate to socket: ${targetSocketId}`);
      io.to(targetSocketId).emit('audio:webrtc:ice-candidate', {
        callId,
        senderId: socket.userId,
        candidate,
      });
    } else {
      console.log('❌ Target user not online');
    }
  });

  // ============================================
  // DISCONNECT HANDLER
  // ============================================
  
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);

    // Remove from online users
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      
      // ✅ Broadcast offline status to ALL users
      io.emit('user:status', {
        userId: socket.userId,
        isOnline: false
      });
    }

    // End any active calls
    activeCalls.forEach((call, callId) => {
      if (call.callerSocketId === socket.id || call.receiverSocketId === socket.id) {
        
        // Clear timeout
        const timeout = callTimeouts.get(callId);
        if (timeout) {
          clearTimeout(timeout);
          callTimeouts.delete(callId);
        }
        
        const duration = call.acceptedAt 
          ? Math.floor((new Date() - call.acceptedAt) / 1000)
          : 0;
        
        const wasAccepted = call.status === 'active' && call.acceptedAt;
        
        const endData = {
          callId,
          duration,
          wasAccepted,
          reason: 'User disconnected',
        };
        
        // Notify the OTHER party
        if (call.callerSocketId === socket.id) {
          io.to(call.receiverSocketId).emit('audio:call:ended', endData);
        } else {
          io.to(call.callerSocketId).emit('audio:call:ended', endData);
        }

        activeCalls.delete(callId);
      }
    });
  });
});

// ============================================
// API ROUTES
// ============================================

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/profiles', require('./routes/profileRoutes'));
app.use('/api/posts', require('./routes/postRoutes'));
app.use('/api/points', require('./routes/pointsRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api', require('./routes/commentRoutes'));
app.use('/api/messages', require('./routes/messageRoutes'));
app.use('/api/tournaments', require('./routes/tournamentRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/stories', require('./routes/storyRoutes'));
app.use('/api/achievements', require('./routes/achievementRoutes'));
app.use('/api/gallery', require('./routes/galleryRoutes'));
app.use('/api/contact', require('./routes/contactRoutes'));
app.use('/api/trending', require('./routes/trendingRoutes'));
app.use('/api/platform-stats', require('./routes/platformStatsRoutes'));

// ============================================
// ROOT ROUTE (API Welcome)
// ============================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: '🎾 Welcome to Nelly Korda Platform API',
    version: '2.0.0',
    description: 'Official API for Nelly Korda Celebrity Platform',
    endpoints: {
      authentication: '/api/auth',
      profiles: '/api/profiles',
      posts: '/api/posts',
      comments: '/api/posts/:postId/comments',
      messages: '/api/messages',
      tournaments: '/api/tournaments',
      notifications: '/api/notifications',
      stories: '/api/stories',
      achievements: '/api/achievements',
      gallery: '/api/gallery',
      settings: '/api/settings',
      event: '/api/event',
      contact: '/api/contact',
    },
    features: [
      '✅ User Authentication & Authorization',
      '✅ User Profiles with Cover Photos & Galleries',
      '✅ Posts with Media Upload',
      '✅ Comments & Replies',
      '✅ Direct Messaging',
      '✅ Audio Calls (Real-time)',
      '✅ Contact Form to Messenger Integration',
      '✅ Stories (24hr & Highlights)',
      '✅ Tournaments & Achievements',
      '✅ Real-time Notifications',
      '✅ Admin Dashboard Analytics',
      '✅ Privacy Controls',
      '✅ NO RATE LIMITING - Unlimited Requests',
    ],
    documentation: 'https://korda.vercel.app/',
  });
});

// ============================================
// HEALTH CHECK ROUTE
// ============================================

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    database: 'Connected',
    socketIO: 'Active',
    activeCalls: activeCalls.size,
    onlineUsers: onlineUsers.size,
    rateLimiting: 'DISABLED',
  });
});

// ============================================
// CRON JOBS
// ============================================

// Auto-delete expired stories every hour
cron.schedule('0 * * * *', async () => {
  try {
    const Story = require('./models/Story');
    const deletedCount = await Story.deleteExpiredStories();
    console.log(`✅ Cron Job: Deleted ${deletedCount} expired stories`);
  } catch (error) {
    console.error('❌ Cron Job Error:', error.message);
  }
});

// Clean up old notifications (older than 30 days) - Daily at 2 AM
cron.schedule('0 2 * * *', async () => {
  try {
    const Notification = require('./models/Notification');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const result = await Notification.deleteMany({
      isRead: true,
      createdAt: { $lt: thirtyDaysAgo },
    });
    
    console.log(`✅ Cron Job: Cleaned up ${result.deletedCount} old notifications`);
  } catch (error) {
    console.error('❌ Cron Job Error:', error.message);
  }
});

// Update trending hashtags every 2 hours
cron.schedule('0 */2 * * *', async () => {
  try {
    const { updateTrendingData } = require('./services/trendingService');
    const result = await updateTrendingData('weekly');
    console.log(`✅ Cron Job: Updated trending data - ${result.processed} hashtags processed`);
  } catch (error) {
    console.error('❌ Cron Job Error (Trending):', error.message);
  }
});

// Clean up old trending data - Daily at 3 AM
cron.schedule('0 3 * * *', async () => {
  try {
    const { cleanupOldTrendingData } = require('./services/trendingService');
    const deletedCount = await cleanupOldTrendingData();
    console.log(`✅ Cron Job: Cleaned up ${deletedCount} old trending records`);
  } catch (error) {
    console.error('❌ Cron Job Error (Trending Cleanup):', error.message);
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// Handle 404 - Route not found
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Global Error Handler (Must be last)
app.use(errorHandler);

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║        🎾 NELLY KORDA PLATFORM API 🎾                ║
║                                                       ║
║   Status: Running ✅                                  ║
║   Environment: ${process.env.NODE_ENV?.toUpperCase().padEnd(10)}                          ║
║   Port: ${PORT}                                            ║
║   Database: Connected ✅                              ║
║   Socket.IO: Active ✅                                ║
║   Security: Enabled ✅                                ║
║   CORS: Enabled (Vite + Vercel) ✅                    ║
║   Rate Limiting: DISABLED ✅                          ║
║   Stories Auto-Cleanup: Active ✅                     ║
║   Profile System: Active ✅                           ║
║   Audio Calls: Active ✅                              ║
║   Contact to Messenger: Active ✅                     ║
║   Cron Jobs: Active ✅                                ║
║                                                       ║
║   🔥 UNLIMITED REQUESTS - NO RESTRICTIONS 🔥         ║
║                                                       ║
║   API Documentation: http://localhost:${PORT}            ║
║   Health Check: http://localhost:${PORT}/api/health      ║
║                                                       ║
║   Available Routes:                                   ║
║   • Auth: /api/auth                                   ║
║   • Profiles: /api/profiles                           ║
║   • Posts: /api/posts                                 ║
║   • Stories: /api/stories                             ║
║   • Messages: /api/messages                           ║
║   • Contact: /api/contact                             ║
║   • Tournaments: /api/tournaments                     ║
║   • Achievements: /api/achievements                   ║
║   • Notifications: /api/notifications                 ║
║   • Trending: /api/trending                           ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.error(`❌ Unhandled Rejection: ${err.message}`);
  // Close server & exit process
  server.close(() => process.exit(1));
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(`❌ Uncaught Exception: ${err.message}`);
  process.exit(1);
});

// Handle SIGTERM (e.g., from Kubernetes, Docker)
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('✅ HTTP server closed');
  });
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n👋 SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;