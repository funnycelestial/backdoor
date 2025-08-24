// controllers/disputeController.js
import Dispute from '../models/disputeModel.js';
import Escrow from '../models/escrowModel.js';
import Auction from '../models/auctionModel.js';
import { refundToBuyer, releaseToVendor } from './escrowController.js';
import { notifyUser, notifyAdmin } from '../services/notificationService.js';

// Constants
const DISPUTE_WINDOW_DAYS = 7; // Allow disputes within 7 days of delivery

// 1. Raise Dispute
export const raiseDispute = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { auctionId, reason, description, evidence } = req.body;
    const userId = req.user.id;

    // Validate auction and escrow
    const auction = await Auction.findById(auctionId)
      .populate('vendor', 'id')
      .populate('highestBidder', 'id')
      .session(session);

    if (!auction) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Auction not found' });
    }

    // Check if user is buyer or seller
    const isBuyer = auction.highestBidder?._id.equals(userId);
    const isSeller = auction.vendor._id.equals(userId);
    if (!isBuyer && !isSeller) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'Not a party to this auction' });
    }

    const escrow = await Escrow.findOne({ auction: auctionId })
      .session(session);
    if (!escrow || escrow.status !== 'HELD') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No active escrow to dispute' });
    }

    // Check dispute window (for buyers)
    if (isBuyer) {
      const deliveryConfirmation = await DeliveryConfirmation.findOne({ 
        auction: auctionId 
      }).session(session);

      if (deliveryConfirmation?.deliveredAt) {
        const disputeDeadline = new Date(deliveryConfirmation.deliveredAt);
        disputeDeadline.setDate(disputeDeadline.getDate() + DISPUTE_WINDOW_DAYS);

        if (new Date() > disputeDeadline) {
          await session.abortTransaction();
          return res.status(400).json({ 
            message: `Dispute window closed (${DISPUTE_WINDOW_DAYS} days after delivery)`
          });
        }
      }
    }

    // Create dispute
    const dispute = await Dispute.create([{
      auction: auctionId,
      transaction: escrow._id,
      raisedBy: userId,
      against: isBuyer ? auction.vendor._id : auction.highestBidder._id,
      reason,
      description,
      evidence,
      status: 'OPEN'
    }], { session });

    // Freeze escrow
    escrow.status = 'DISPUTED';
    await escrow.save({ session });

    await session.commitTransaction();

    // Notify parties
    await Promise.all([
      notifyUser(auction.vendor._id, 'DISPUTE_RAISED', {
        auctionId,
        disputeId: dispute[0]._id
      }),
      notifyAdmin('NEW_DISPUTE', {
        disputeId: dispute[0]._id,
        reason
      })
    ]);

    res.json(dispute[0]);

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Failed to raise dispute: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};

// 2. Add Evidence
export const addEvidence = async (req, res) => {
  try {
    const { url, type } = req.body;
    const dispute = await Dispute.findOneAndUpdate(
      {
        _id: req.params.disputeId,
        $or: [
          { raisedBy: req.user.id },
          { against: req.user.id }
        ],
        status: { $in: ['OPEN', 'UNDER_REVIEW'] }
      },
      {
        $push: { evidence: { url, type } }
      },
      { new: true }
    );

    if (!dispute) {
      return res.status(404).json({ message: 'Dispute not found or closed' });
    }

    res.json(dispute);
  } catch (error) {
    res.status(500).json({ message: 'Failed to add evidence: ' + error.message });
  }
};

// 3. Assign Admin
export const assignAdmin = async (req, res) => {
  try {
    const dispute = await Dispute.findByIdAndUpdate(
      req.params.disputeId,
      {
        assignedTo: req.body.adminId,
        status: 'UNDER_REVIEW'
      },
      { new: true }
    );

    if (!dispute) {
      return res.status(404).json({ message: 'Dispute not found' });
    }

    await notifyUser(dispute.raisedBy, 'DISPUTE_ASSIGNED', {
      disputeId: dispute._id,
      adminId: req.body.adminId
    });

    res.json(dispute);
  } catch (error) {
    res.status(500).json({ message: 'Assignment failed: ' + error.message });
  }
};

// 4. Resolve Dispute (Admin)
export const resolveDispute = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { decision, notes } = req.body;
    const dispute = await Dispute.findById(req.params.disputeId)
      .populate('transaction')
      .session(session);

    if (!dispute) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Dispute not found' });
    }

    // Apply resolution
    dispute.status = 'RESOLVED';
    dispute.resolution = { decision, notes };
    await dispute.save({ session });

    // Handle funds based on decision
    switch (decision) {
      case 'REFUND_BUYER':
        await refundToBuyer(dispute.auction, 'DISPUTE_RESOLUTION', session);
        break;
      case 'RELEASE_TO_SELLER':
        await releaseToVendor(dispute.auction, session);
        break;
      case 'PARTIAL_REFUND':
        // Example: Refund 50% to buyer, release 50% to seller
        await partialResolution(dispute.auction, 0.5, session);
        break;
    }

    await session.commitTransaction();

    // Notify both parties
    await Promise.all([
      notifyUser(dispute.raisedBy, 'DISPUTE_RESOLVED', {
        decision,
        notes
      }),
      notifyUser(dispute.against, 'DISPUTE_RESOLVED', {
        decision,
        notes
      })
    ]);

    res.json(dispute);

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

// Helper: Partial refund/release
const partialResolution = async (auctionId, refundRatio, session) => {
  const escrow = await Escrow.findOne({ auction: auctionId }).session(session);
  const refundAmount = escrow.tokenAmount * refundRatio;
  const vendorAmount = escrow.tokenAmount * (1 - refundRatio);

  // Refund buyer
  await User.findByIdAndUpdate(
    escrow.buyer,
    { $inc: { balance: refundAmount } },
    { session }
  );

  // Pay vendor
  await User.findByIdAndUpdate(
    escrow.vendor,
    { $inc: { balance: vendorAmount } },
    { session }
  );

  // Record transactions
  await TokenTransaction.create([
    {
      user: escrow.buyer,
      type: 'DISPUTE_PARTIAL_REFUND',
      amount: refundAmount,
      status: 'SUCCESS',
      linkedAuction: auctionId
    },
    {
      user: escrow.vendor,
      type: 'DISPUTE_PARTIAL_PAYOUT',
      amount: vendorAmount,
      status: 'SUCCESS',
      linkedAuction: auctionId
    }
  ], { session });
};

// 5. List Disputes (Admin)
export const listDisputes = async (req, res) => {
  try {
    const { status, assignedTo } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;

    const disputes = await Dispute.find(filter)
      .populate('raisedBy', 'username')
      .populate('against', 'username')
      .populate('assignedTo', 'username')
      .sort({ createdAt: -1 });

    res.json(disputes);
  } catch (error) {
    res.status(500).json({ message: 'Fetch failed: ' + error.message });
  }
};