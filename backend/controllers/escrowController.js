// controllers/escrowController.js
import Escrow from '../models/escrowModel.js';
import TokenTransaction from '../models/tokentransactionModel.js';
import User from '../models/userModel.js';
import Auction from '../models/auctionModel.js';
import DeliveryConfirmation from '../models/deliveryConfirmationModel.js';
import { notifyUser } from '../services/notificationService.js';

// 1. Create Escrow (Triggered on Auction Close)
export const createEscrow = async (auctionId) => {
  const auction = await Auction.findById(auctionId)
    .populate('highestBidder', 'id balance')
    .populate('vendor', 'id');

  if (!auction?.highestBidder || !auction.winningBidAmount) {
    throw new Error('Invalid auction state for escrow');
  }

  const escrow = await Escrow.create({
    auction: auctionId,
    buyer: auction.highestBidder._id,
    vendor: auction.vendor._id,
    tokenAmount: auction.winningBidAmount,
    status: 'HELD'
  });

  // Log the token deduction (already happened in bid closing)
  await TokenTransaction.create({
    user: auction.highestBidder._id,
    type: 'ESCROW_HOLD',
    amount: auction.winningBidAmount,
    status: 'SUCCESS',
    linkedAuction: auctionId,
    linkedEscrow: escrow._id
  });

  return escrow;
};

// 2. Release to Vendor (Delivery Confirmed)
export const releaseToVendor = async (auctionId) => {
  const escrow = await Escrow.findOne({ auction: auctionId, status: 'HELD' });
  if (!escrow) throw new Error('No active escrow found');

  const auction = await Auction.findById(auctionId);
  const platformFee = escrow.tokenAmount * 0.1; // 10% platform cut
  const vendorAmount = escrow.tokenAmount - platformFee;

  // Update escrow
  escrow.status = 'RELEASED';
  escrow.releaseReason = 'DELIVERY_CONFIRMED';
  escrow.releasedAt = new Date();
  await escrow.save();

  // Credit vendor (net of fees)
  await User.findByIdAndUpdate(escrow.vendor, {
    $inc: { balance: vendorAmount }
  });

  // Record transactions
  await Promise.all([
    // Vendor payout
    TokenTransaction.create({
      user: escrow.vendor,
      type: 'PAYOUT_VENDOR',
      amount: vendorAmount,
      status: 'SUCCESS',
      linkedAuction: auctionId,
      linkedEscrow: escrow._id
    }),
    // Platform fee collection
    TokenTransaction.create({
      user: escrow.vendor,
      type: 'PLATFORM_FEE',
      amount: platformFee,
      status: 'SUCCESS',
      linkedAuction: auctionId
    })
  ]);

  // Notify both parties
  await Promise.all([
    notifyUser(escrow.vendor, 'ESCROW_RELEASED', {
      amount: vendorAmount,
      auctionTitle: auction.title
    }),
    notifyUser(escrow.buyer, 'FUNDS_RELEASED_TO_VENDOR', {
      auctionTitle: auction.title
    })
  ]);

  return escrow;
};

// 3. Refund to Buyer (Dispute/Cancellation)
export const refundToBuyer = async (auctionId, reason = 'DISPUTE_RESOLVED') => {
  const escrow = await Escrow.findOne({ auction: auctionId, status: 'HELD' });
  if (!escrow) throw new Error('No active escrow found');

  const auction = await Auction.findById(auctionId);

  // Update escrow
  escrow.status = 'REFUNDED';
  escrow.releaseReason = reason;
  escrow.releasedAt = new Date();
  await escrow.save();

  // Refund buyer
  await User.findByIdAndUpdate(escrow.buyer, {
    $inc: { balance: escrow.tokenAmount }
  });

  // Record transaction
  await TokenTransaction.create({
    user: escrow.buyer,
    type: 'ESCROW_REFUND',
    amount: escrow.tokenAmount,
    status: 'SUCCESS',
    linkedAuction: auctionId,
    linkedEscrow: escrow._id
  });

  // Notify both parties
  await Promise.all([
    notifyUser(escrow.buyer, 'ESCROW_REFUNDED', {
      amount: escrow.tokenAmount,
      auctionTitle: auction.title
    }),
    notifyUser(escrow.vendor, 'ESCROW_REFUNDED_TO_BUYER', {
      auctionTitle: auction.title,
      reason
    })
  ]);

  return escrow;
};

// 4. Mark as Disputed (Delivery Dispute)
export const markDisputed = async (auctionId) => {
  const escrow = await Escrow.findOneAndUpdate(
    { auction: auctionId, status: 'HELD' },
    { status: 'DISPUTED' },
    { new: true }
  );

  if (!escrow) throw new Error('Escrow not found or already released');

  // Freeze related transactions
  await TokenTransaction.updateMany(
    { linkedEscrow: escrow._id },
    { $set: { isFrozen: true } }
  );

  return escrow;
};

// 5. Admin Override (Manual Release/Refund)
export const adminEscrowAction = async (req, res) => {
  try {
    const { action, reason } = req.body;
    const escrow = await Escrow.findById(req.params.id);

    if (!escrow) {
      return res.status(404).json({ message: 'Escrow not found' });
    }

    let result;
    switch (action) {
      case 'RELEASE':
        result = await releaseToVendor(escrow.auction);
        break;
      case 'REFUND':
        result = await refundToBuyer(escrow.auction, reason);
        break;
      default:
        return res.status(400).json({ message: 'Invalid action' });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Admin action failed: ' + error.message });
  }
};

// Helper: Get active escrow for auction
export const getAuctionEscrow = async (auctionId) => {
  return Escrow.findOne({ auction: auctionId })
    .populate('buyer', 'username')
    .populate('vendor', 'username');
};

// controllers/escrowController.js

/**
 * Release escrow funds to vendor after delivery confirmation
 * @param {string} auctionId - ID of the auction
 * @param {ClientSession} session - MongoDB session for transaction
 * @returns {Promise<void>}
 */
export const releaseEscrow = async (auctionId, session) => {
  const escrow = await Escrow.findOne({ auction: auctionId, status: 'HELD' })
    .session(session);

  if (!escrow) {
    throw new Error('No active escrow found for this auction');
  }

  const auction = await Auction.findById(auctionId).session(session);
  const platformFee = escrow.tokenAmount * 0.1; // 10% platform fee
  const vendorAmount = escrow.tokenAmount - platformFee;

  // Update escrow status
  escrow.status = 'RELEASED';
  escrow.releaseReason = 'DELIVERY_CONFIRMED';
  escrow.releasedAt = new Date();
  await escrow.save({ session });

  // Credit vendor's account (net of fees)
  await User.findByIdAndUpdate(
    escrow.vendor,
    { $inc: { balance: vendorAmount } },
    { session }
  );

  // Create token transactions
  await Promise.all([
    // Vendor payout transaction
    TokenTransaction.create([{
      user: escrow.vendor,
      type: 'PAYOUT_VENDOR',
      amount: vendorAmount,
      status: 'SUCCESS',
      linkedAuction: auctionId,
      linkedEscrow: escrow._id
    }], { session }),

    // Platform fee transaction
    TokenTransaction.create([{
      user: escrow.vendor,
      type: 'PLATFORM_FEE',
      amount: platformFee,
      status: 'SUCCESS',
      linkedAuction: auctionId,
      linkedEscrow: escrow._id
    }], { session })
  ]);

  // Send notifications (outside transaction)
  process.nextTick(async () => {
    try {
      await Promise.all([
        notifyUser(escrow.vendor, 'ESCROW_RELEASED', {
          amount: vendorAmount,
          auctionTitle: auction.title
        }),
        notifyUser(escrow.buyer, 'FUNDS_RELEASED_TO_VENDOR', {
          auctionTitle: auction.title
        })
      ]);
    } catch (error) {
      console.error('Notification sending failed:', error);
    }
  });
};