// controllers/auctionController.js
import Auction from '../models/auctionModel.js';
import User from '../models/userModel.js';
import { validationResult } from 'express-validator';
import { refundLosingBids, releaseTokensToVendor } from './tokenTransactionController.js';
import { setWinningBid } from './bidController.js';
import { createEscrow } from './escrowController.js';
import { createConfirmation } from './deliveryConfirmationController.js';
import TokenTransaction from '../models/tokentransactionModel.js';
import { notifyUsers } from '../services/notificationService.js';// Assuming you have a utility function to set winning bid

// 1. Create Auction
export const createAuction = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { title, description, images, startingPrice, category, condition, isDigital, startTime, endTime, deliveryRequired } = req.body;

    // Validate auction times
    if (new Date(endTime) <= new Date(startTime)) {
      return res.status(400).json({ message: 'End time must be after start time' });
    }

    const auction = await Auction.create({
      title,
      description,
      images,
      startingPrice,
      currentPrice: startingPrice,
      vendor: req.user.id,
      category,
      condition,
      isDigital,
      startTime,
      endTime,
      deliveryRequired: isDigital ? false : deliveryRequired // Digital items can't require delivery
    });

    res.status(201).json(auction);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 2. Get All Active Auctions
export const getActiveAuctions = async (req, res) => {
  try {
    const auctions = await Auction.find({ 
      isActive: true,
      startTime: { $lte: new Date() } // Only started auctions
    }).populate('vendor', 'username profilePhoto');

    res.json(auctions);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 3. Get Auction by ID
export const getAuctionById = async (req, res) => {
  try {
    const auction = await Auction.findById(req.params.id)
      .populate('vendor', 'username profilePhoto rating')
      .populate('highestBidder', 'username profilePhoto');

    if (!auction) {
      return res.status(404).json({ message: 'Auction not found' });
    }

    res.json(auction);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 4. Update Auction
export const updateAuction = async (req, res) => {
  try {
    const auction = await Auction.findById(req.params.id);

    // Validate ownership and timing
    if (auction.vendor.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this auction' });
    }

    if (new Date() > auction.startTime) {
      return res.status(400).json({ message: 'Cannot update auction after it has started' });
    }

    const updates = req.body;
    delete updates.startTime; // Prevent startTime manipulation
    delete updates.vendor; // Prevent owner change

    const updatedAuction = await Auction.findByIdAndUpdate(req.params.id, updates, { 
      new: true,
      runValidators: true 
    });

    res.json(updatedAuction);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 5. Delete Auction
export const deleteAuction = async (req, res) => {
  try {
    const auction = await Auction.findById(req.params.id);

    if (auction.vendor.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this auction' });
    }

    if (new Date() > auction.startTime) {
      return res.status(400).json({ message: 'Cannot delete auction after it has started' });
    }

    await auction.remove();
    res.json({ message: 'Auction deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};


//6. close Auction
export const closeAuction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const auction = await Auction.findById(req.params.id)
      .populate('vendor', 'id balance')
      .populate('highestBidder', 'id')
      .session(session);

    // Validations
    if (!auction) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Auction not found' });
    }

    if (!auction.isActive) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Auction already closed' });
    }

    const now = new Date();
    if (now < auction.endTime && !req.forceClose) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Auction has not ended yet' });
    }

    // Mark as inactive
    auction.isActive = false;
    auction.endedAt = now;

    // Process winner if exists
    if (auction.highestBidder) {
      // 1. Set winning bid (atomic update)
      const winningBid = await setWinningBid(auction._id, session);
      auction.winningBidAmount = winningBid.amount;

      // 2. Create escrow hold
      await createEscrow(auction._id, session);

      // 3. Refund losing bidders (batch operation)
      await refundLosingBids(auction._id, session);

      // 4. Create delivery confirmation record
      await createConfirmation(auction._id, session);

      // 5. Platform fee tracking
      const platformFee = auction.winningBidAmount * 0.1;
      await TokenTransaction.create([{
        user: auction.vendor._id,
        type: 'PLATFORM_FEE',
        amount: platformFee,
        status: 'PENDING', // Will confirm when delivery completes
        linkedAuction: auction._id
      }], { session });
    }

    // Commit all changes
    await auction.save({ session });
    await session.commitTransaction();

    // Real-time notifications
    req.io?.to(`auction_${auction._id}`).emit('auction_closed', {
      winnerId: auction.highestBidder,
      finalPrice: auction.winningBidAmount
    });

    // Email/SMS notifications
    await notifyUsers({
      winnerId: auction.highestBidder,
      vendorId: auction.vendor._id,
      auctionId: auction._id
    });

    res.json({
      success: true,
      winner: auction.highestBidder,
      finalPrice: auction.winningBidAmount,
      nextStep: auction.highestBidder ? 'awaiting_delivery_confirmation' : 'no_winner'
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Auction close failed:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to close auction: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};
// 7. Confirm Item Received
export const confirmReceipt = async (req, res) => {
  try {
    const auction = await Auction.findById(req.params.id);

    if (!auction.highestBidder || auction.highestBidder.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not the auction winner' });
    }

    auction.winnerConfirmed = true;
    auction.vendorPaid = true; // In reality, trigger token transfer here
    
    // Credit vendor's balance (pseudo-code)
    const vendor = await User.findById(auction.vendor);
    vendor.balance += auction.winningBidAmount * 0.9; // Assuming 10% platform fee
    await vendor.save();

    await auction.save();
    res.json({ message: 'Item receipt confirmed. Vendor has been paid.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 8. Add Delivery Info
export const updateDeliveryInfo = async (req, res) => {
  try {
    const auction = await Auction.findById(req.params.id);

    if (auction.vendor.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update delivery info' });
    }

    if (!auction.deliveryRequired) {
      return res.status(400).json({ message: 'This item does not require delivery' });
    }

    auction.deliveryTrackingInfo = req.body.trackingInfo;
    await auction.save();

    res.json({ message: 'Delivery info updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 9. Get Vendor Auctions
export const getVendorAuctions = async (req, res) => {
  try {
    const auctions = await Auction.find({ vendor: req.user.id })
      .sort({ createdAt: -1 });

    res.json(auctions);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 10. Get Won Auctions
export const getWonAuctions = async (req, res) => {
  try {
    const auctions = await Auction.find({ 
      highestBidder: req.user.id,
      isActive: false 
    }).populate('vendor', 'username profilePhoto');

    res.json(auctions);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};