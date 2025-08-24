// controllers/deliveryConfirmationController.js
import mongoose from 'mongoose';
import DeliveryConfirmation from '../models/deliveryConfirmationModel.js';
import Auction from '../models/auctionModel.js';
import TokenTransaction from '../models/tokentransactionModel.js';
import User from '../models/userModel.js';
import { releaseEscrow, refundToBuyer } from './escrowController.js';
import { notifyUser , notifyAdmin } from '../services/notificationService.js';

// 1. Create Confirmation Record (Triggered on Auction Close)
export const createConfirmation = async (auctionId) => {
  const auction = await Auction.findById(auctionId)
    .populate('vendor', 'id')
    .populate('highestBidder', 'id');

  if (!auction?.highestBidder) return null;

  const confirmation = await DeliveryConfirmation.create({
    auction: auctionId,
    vendor: auction.vendor._id,
    buyer: auction.highestBidder._id,
    status: auction.isDigital ? 'PENDING_DELIVERY' : 'PENDING_SHIPMENT'
  });

  // Notify both parties
  await Promise.all([
    notifyUser (auction.vendor._id, 'DELIVERY_CONFIRMATION_CREATED', {
      auctionTitle: auction.title,
      confirmationId: confirmation._id
    }),
    notifyUser (auction.highestBidder._id, 'AWAITING_DELIVERY', {
      auctionTitle: auction.title
    })
  ]);

  return confirmation;
};

// 2. Vendor Marks as Shipped
export const markShipped = async (req, res) => {
  try {
    const { trackingNumber, proofUrl } = req.body;
    const confirmation = await DeliveryConfirmation.findOneAndUpdate(
      {
        auction: req.params.auctionId,
        vendor: req.user.id,
        status: 'PENDING_SHIPMENT'
      },
      {
        status: 'SHIPPED',
        shippedAt: new Date(),
        trackingNumber,
        proofUrl
      },
      { new: true }
    );

    if (!confirmation) {
      return res.status(404).json({ message: 'No pending shipment found' });
    }

    // Notify buyer
    await notifyUser (confirmation.buyer, 'ITEM_SHIPPED', {
      trackingNumber,
      auctionId: req.params.auctionId
    });

    res.json(confirmation);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update shipment: ' + error.message });
  }
};

// 3. Buyer Confirms Delivery
export const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const confirmation = await DeliveryConfirmation.findOneAndUpdate(
      {
        auction: req.params.auctionId,
        buyer: req.user.id,
        status: { $in: ['SHIPPED', 'PENDING_DELIVERY'] } // Digital items skip shipping
      },
      {
        status: 'DELIVERED',
        deliveredAt: new Date()
      },
      { new: true, session }
    );

    if (!confirmation) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Nothing to confirm' });
    }

    // Release escrow to vendor
    await releaseEscrow(confirmation.auction, session);

    // Mark platform fee as completed
    await TokenTransaction.updateOne(
      { 
        linkedAuction: confirmation.auction,
        type: 'PLATFORM_FEE',
        status: 'PENDING'
      },
      { status: 'SUCCESS' },
      { session }
    );

    await session.commitTransaction();

    res.json({ 
      success: true,
      message: 'Delivery confirmed. Vendor payment released.'
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Confirmation failed: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};

// 4. Open Dispute
export const openDispute = async (req, res) => {
  try {
    const { reason } = req.body;
    const confirmation = await DeliveryConfirmation.findOneAndUpdate(
      {
        auction: req.params.auctionId,
        buyer: req.user.id,
        status: { $ne: 'DELIVERED' }
      },
      {
        status: 'DISPUTED',
        disputeReason: reason
      },
      { new: true }
    );

    if (!confirmation) {
      return res.status(400).json({ message: 'Cannot dispute this delivery' });
    }

    // Notify admin and vendor
    await Promise.all([
      notifyAdmin('NEW_DISPUTE', {
        confirmationId: confirmation._id,
        reason
      }),
      notifyUser (confirmation.vendor, 'DISPUTE_OPENED', {
        auctionId: req.params.auctionId
      })
    ]);

    res.json(confirmation);
  } catch (error) {
    res.status(500).json({ message: 'Dispute failed: ' + error.message });
  }
};

// 5. Resolve Dispute (Admin)
export const resolveDispute = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { resolution, notes } = req.body;
    const confirmation = await DeliveryConfirmation.findById(req.params.id).session(session);

    if (!confirmation) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Record not found' });
    }

    // Handle resolution
    if (resolution === 'RELEASE_TO_VENDOR') {
      confirmation.status = 'DELIVERED';
      await releaseEscrow(confirmation.auction, session);
    } else if (resolution === 'REFUND_BUYER') {
      confirmation.status = 'CANCELLED';
      await refundBuyer(confirmation.auction, confirmation.buyer);
    }

    confirmation.resolutionNotes = notes;
    await confirmation.save({ session });
    await session.commitTransaction();

    res.json({
      success: true,
      resolution,
      notes
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Resolution failed: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};
