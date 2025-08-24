// controllers/bidController.js
import Bid from '../models/bidModel.js';
import Auction from '../models/auctionModel.js';
import User from '../models/userModel.js';

// Constants for anti-sniping and fraud detection
const ANTI_SNIPING_EXTENSION = 30; // Extend auction by 30 sec if last-minute bid
const FRAUD_RULES = {
  MIN_BID_INCREASE: 0.05, // 5% minimum bid increment
  TOO_FAST_BIDS: 5000, // 5 seconds between bids (ms)
};

// controllers/bidController.js

// New: Escrow Service Integration
const escrowBidTokens = async (bid) => {
  try {
    const user = await User.findById(bid.bidder);
    user.escrowedBalance = (user.escrowedBalance || 0) + bid.amount;
    user.balance -= bid.amount;
    await user.save();
    return true;
  } catch (error) {
    console.error('Escrow failed:', error);
    throw error;
  }
};

//1. Merged placeBid function
export const placeBid = async (req, res) => {
  let bid; // declare outside try for cleanup
  try {
    const { auctionId, amount } = req.body;
    const userId = req.user.id;

    // Validate auction and user existence
    const [auction, user] = await Promise.all([
      Auction.findById(auctionId),
      User.findById(userId)
    ]);
    if (!auction || !auction.isActive || new Date() > auction.endTime) {
      return res.status(400).json({ message: 'Bidding closed or auction not found' });
    }
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Bid amount and balance checks
    const minValidBid = auction.currentPrice * (1 + FRAUD_RULES.MIN_BID_INCREASE);
    if (amount < minValidBid) {
      return res.status(400).json({
        message: `Bid must be ≥ ${minValidBid.toFixed(2)} (${FRAUD_RULES.MIN_BID_INCREASE * 100}%)`
      });
    }
    if (user.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Fraud detection: too frequent bids
    const lastUserBid = await Bid.findOne({ bidder: userId, auction: auctionId }).sort({ createdAt: -1 });
    if (lastUserBid && (Date.now() - lastUserBid.createdAt.getTime()) < FRAUD_RULES.TOO_FAST_BIDS) {
      return res.status(429).json({ message: 'Bid too fast. Wait 5 seconds.' });
    }

    // Create pending bid
    bid = await Bid.create({
      auction: auctionId,
      bidder: userId,
      amount,
      status: 'pending',
      flaggedForReview: amount > auction.currentPrice * FRAUD_RULES.SUSPICIOUS_JUMP_MULTIPLIER,
    });

    // Escrow tokens and finalize within transaction
    await escrowBidTokens(bid);
    const result = await finalizeBidPlacement(bid);

    res.status(201).json({
      success: true,
      bidId: bid._id,
      newPrice: result.newPrice,
      extendedEndTime: result.extendedEndTime,
      remainingBalance: result.userBalance,
      escrowedAmount: bid.amount,
    });

  } catch (error) {
    if (bid) await Bid.findByIdAndDelete(bid._id);
    res.status(500).json({ message: 'Bid failed: ' + error.message });
  }
};

const finalizeBidPlacement = async (bid) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const auction = await Auction.findById(bid.auction).session(session);
    if (!auction) throw new Error('Auction not found during bid finalization');

    // Anti-sniping extension
    const timeRemaining = (auction.endTime - Date.now()) / 1000;
    let extendedEndTime;
    if (timeRemaining < ANTI_SNIPING_EXTENSION) {
      auction.endTime = new Date(Date.now() + ANTI_SNIPING_EXTENSION * 1000);
      extendedEndTime = auction.endTime;
    }

    // Update auction highest bid and bid count
    auction.currentPrice = bid.amount;
    auction.highestBidder = bid.bidder;
    auction.bidCount += 1;
    await auction.save({ session });

    // Update bid status
    await Bid.findByIdAndUpdate(bid._id, { status: 'active' }, { session });

    await session.commitTransaction();

    const userBalance = await User.findById(bid.bidder).select('balance');

    return {
      newPrice: auction.currentPrice,
      extendedEndTime,
      userBalance: userBalance.balance,
    };

  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// 2. Get All Bids for an Auction (Anonymous)
export const getAuctionBids = async (req, res) => {
  try {
    const bids = await Bid.find({ auction: req.params.auctionId })
      .sort({ amount: -1 })
      .select('amount createdAt') // Hide bidder info
      .lean();

    // Anonymize bids for public view
    const anonymousBids = bids.map((bid, index) => ({
      position: index + 1,
      amount: bid.amount,
      time: bid.createdAt,
      bidder: `Bidder #${bid._id.toString().slice(-4)}` // Example: "Bidder #A3F2"
    }));

    res.json(anonymousBids);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 3. Get All Bids by a User (Private)
export const getUserBids = async (req, res) => {
  try {
    const bids = await Bid.find({ bidder: req.user.id })
      .populate('auction', 'title currentPrice endTime')
      .sort({ createdAt: -1 });

    res.json(bids);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 4. Mark Winning Bid (System-Triggered)
export const setWinningBid = async (auctionId) => {
  try {
    // Find highest bid
    const winningBid = await Bid.findOne({ auction: auctionId })
      .sort({ amount: -1 });

    if (winningBid) {
      // Mark all bids as non-winning first
      await Bid.updateMany(
        { auction: auctionId },
        { $set: { isWinningBid: false } }
      );

      // Set the winner
      winningBid.isWinningBid = true;
      await winningBid.save();

      return winningBid;
    }
    return null;
  } catch (error) {
    console.error('Error setting winning bid:', error);
    throw error;
  }
};

// 5. Delete Bid (Admin/Vendor)
export const deleteBid = async (req, res) => {
  try {
    const bid = await Bid.findById(req.params.bidId);
    if (!bid) {
      return res.status(404).json({ message: 'Bid not found' });
    }

    const auction = await Auction.findById(bid.auction);
    const now = new Date();

    // Only allow deletion if auction hasn't started
    if (now >= auction.startTime) {
      return res.status(400).json({ message: 'Cannot delete bid after auction starts' });
    }

    await bid.remove();
    res.json({ message: 'Bid deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 6. Get Highest Bid for Auction
export const getHighestBid = async (req, res) => {
  try {
    const bid = await Bid.findOne({ auction: req.params.auctionId })
      .sort({ amount: -1 })
      .populate('bidder', 'username');

    res.json(bid || { message: 'No bids yet' });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 7. Get Bid Count for Auction
export const getBidCount = async (req, res) => {
  try {
    const count = await Bid.countDocuments({ auction: req.params.auctionId });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// 8. Retract Bid (With Penalty)
export const retractBid = async (req, res) => {
  try {
    const bid = await Bid.findById(req.params.bidId);
    if (!bid) return res.status(404).json({ message: 'Bid not found' });

    const auction = await Auction.findById(bid.auction);
    const user = await User.findById(bid.bidder);

    // Validation
    if (bid.bidder.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not your bid' });
    }

    if (new Date() > auction.endTime) {
      return res.status(400).json({ message: 'Cannot retract after auction ends' });
    }

    // Penalty: 10% of bid amount or fixed fee (whichever is higher)
    const penalty = Math.max(
      bid.amount * 0.1, 
      0.5 // Minimum 0.5 token penalty
    );

    // Update bid
    bid.isRetracted = true;
    bid.retractionPenalty = penalty;
    await bid.save();

    // Refund user (amount - penalty)
    user.balance += (bid.amount - penalty);
    await user.save();

    // If this was the highest bid, reset auction price
    if (auction.highestBidder?.toString() === bid.bidder.toString()) {
      const newHighestBid = await Bid.findOne({
        auction: bid.auction,
        isRetracted: false
      }).sort({ amount: -1 });

      auction.currentPrice = newHighestBid?.amount || auction.startingPrice;
      auction.highestBidder = newHighestBid?.bidder || null;
      await auction.save();
    }

    res.json({ 
      refunded: bid.amount - penalty,
      penaltyApplied: penalty
    });

  } catch (error) {
    res.status(500).json({ 
      message: 'Retraction failed: ' + error.message 
    });
  }
};

// 9. Fraud Review Endpoints (Admin)
export const flagBidReview = async (req, res) => {
  try {
    const bid = await Bid.findByIdAndUpdate(
      req.params.bidId,
      { flaggedForReview: true },
      { new: true }
    );
    res.json(bid);
  } catch (error) {
    res.status(500).json({ message: 'Error flagging bid for review: ' + error.message });
  }
};

export const getSuspiciousBids = async (req, res) => {
  try {
    const bids = await Bid.find({ flaggedForReview: true })
      .populate('bidder', 'username email')
      .populate('auction', 'title');
    res.json(bids);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching suspicious bids: ' + error.message });
  }
};
