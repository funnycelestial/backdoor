// controllers/notificationController.js
import Notification from '../models/notificationModel.js';
import User from '../models/userModel.js';
import { sendEmail, sendSMS, sendPush } from '../services/notificationDelivery.js';
import { socketEmitter } from '../services/socketService.js';
import { queue } from '../services/queueService.js';

// 1. Create Notification
export const createNotification = async ({
  userId,
  type,
  title,
  message,
  data = {},
  channels = ['IN_APP'],
  referenceId,
  priority = 'NORMAL'
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Check user exists
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');

    // Check notification preferences
    const finalChannels = filterAllowedChannels(userId, type, channels);
    if (finalChannels.length === 0) {
      await session.abortTransaction();
      return null; // No allowed channels
    }

    // Create notification
    const notification = await Notification.create([{
      user: userId,
      type,
      title,
      message,
      data,
      channel: finalChannels,
      referenceId,
      priority,
      delivered: finalChannels.includes('IN_APP') // Socket delivers immediately
    }], { session });

    await session.commitTransaction();

    // Real-time delivery
    if (finalChannels.includes('IN_APP')) {
      socketEmitter.to(`user_${userId}`).emit('notification:new', notification[0]);
    }

    // Queue external deliveries
    if (finalChannels.some(ch => ch !== 'IN_APP')) {
      await queue.add('deliver-notification', {
        notificationId: notification[0]._id,
        channels: finalChannels.filter(ch => ch !== 'IN_APP')
      });
    }

    return notification[0];

  } catch (error) {
    await session.abortTransaction();
    console.error('Notification creation failed:', error);
    throw error;
  } finally {
    session.endSession();
  }
};

// 2. Get Notifications
export const getNotifications = async (req, res) => {
  try {
    const { limit = 20, offset = 0, unreadOnly, type } = req.query;
    const filter = { user: req.user.id };
    if (unreadOnly) filter.read = false;
    if (type) filter.type = type;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(parseInt(offset))
        .limit(parseInt(limit)),
      Notification.countDocuments({ ...filter, read: false })
    ]);

    res.json({
      notifications,
      meta: {
        totalUnread: unreadCount,
        hasMore: notifications.length === parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch notifications: ' + error.message });
  }
};

// 3. Mark as Read
export const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    res.status(500).json({ message: 'Update failed: ' + error.message });
  }
};

// 4. Mark All as Read
export const markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, read: false },
      { read: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Update failed: ' + error.message });
  }
};

// 5. Delete Notification
export const deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user.id
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Deletion failed: ' + error.message });
  }
};

// 6. Admin Broadcast
export const sendBroadcast = async (req, res) => {
  try {
    const { userIds, title, message, type = 'SYSTEM', channels } = req.body;

    // Queue in background
    await queue.add('broadcast-notification', {
      userIds,
      notification: { title, message, type, channels }
    });

    res.json({ success: true, message: 'Broadcast queued for processing' });
  } catch (error) {
    res.status(500).json({ message: 'Broadcast failed: ' + error.message });
  }
};

// Helper: Filter channels by user preferences
const filterAllowedChannels = async (userId, type, proposedChannels) => {
  const preferences = await UserNotificationPreference.findOne({ user: userId });
  if (!preferences) return proposedChannels;

  // Example logic - adjust based on your preference schema
  return proposedChannels.filter(channel => {
    if (channel === 'IN_APP') return true; // Always allow in-app
    return preferences[type]?.[channel] !== false;
  });
};

// Queue worker for external deliveries
export const processNotificationDelivery = async (job) => {
  const { notificationId, channels } = job.data;
  const notification = await Notification.findById(notificationId);

  if (!notification || notification.delivered) return;

  try {
    const deliveryPromises = channels.map(async channel => {
      switch (channel) {
        case 'EMAIL':
          await sendEmail({
            to: notification.user.email,
            subject: notification.title,
            text: notification.message
          });
          break;
        case 'SMS':
          await sendSMS({
            to: notification.user.phone,
            body: `${notification.title}: ${notification.message}`
          });
          break;
        case 'PUSH':
          await sendPush({
            userId: notification.user._id,
            title: notification.title,
            body: notification.message,
            data: notification.data
          });
          break;
      }
    });

    await Promise.all(deliveryPromises);
    notification.delivered = true;
    await notification.save();
  } catch (error) {
    console.error('Delivery failed:', error);
    throw error; // Will trigger retry if configured
  }
};