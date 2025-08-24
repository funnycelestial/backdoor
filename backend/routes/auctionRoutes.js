const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const Auction = require('../models/auctionModel');
const Bid = require('../models/bidModel');
const User = require('../models/userModel');
const TokenTransaction = require('../models/tokenTransactionModel');
const { auth, optionalAuth, moderatorAuth } = require('../middleware/auth');
const { biddingLimiter } = require('../middleware/rateLimiter');
const { uploadMultiple } = require('../middleware/upload');
const { asyncHandler, formatValidationErrors, NotFoundError, ValidationError } = require('../middleware/errorHandler');
const webSocketController = require('../controllers/webSocketController');
const logger = require('../utils/logger');

const router = express.Router();

// @route   GET /api/v1/auctions
// @desc    Get all auctions with filters
// @access  Public
router.get('/', [
  query('type').optional().isIn(['forward', 'reverse']).withMessage('Invalid auction type'),
  query('status').optional().isIn(['draft', 'pending', 'active', 'ended', 'cancelled']).withMessage('Invalid status'),
  query('category').optional().isString().withMessage('Invalid category'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('sort').optional().isIn(['newest', 'oldest', 'ending_soon', 'price_low', 'price_high', 'most_bids']).withMessage('Invalid sort option'),
  query('search').optional().isString().withMessage('Search must be a string'),
  query('price_min').optional().isFloat({ min: 0 }).withMessage('Minimum price must be non-negative'),
  query('price_max').optional().isFloat({ min: 0 }).withMessage('Maximum price must be non-negative')
], optionalAuth, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const {
    type,
    status = 'active',
    category,
    page = 1,
    limit = 20,
    sort = 'newest',
    search,
    price_min,
    price_max
  } = req.query;

  // Build query
  const query = {};
  
  if (type) query.type = type;
  if (status) query.status = status;
  if (category) query.category = category;
  
  // Price range filter
  if (price_min || price_max) {
    query['pricing.currentBid'] = {};
    if (price_min) query['pricing.currentBid'].$gte = parseFloat(price_min);
    if (price_max) query['pricing.currentBid'].$lte = parseFloat(price_max);
  }

  // Search filter
  if (search) {
    query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { 'specifications.brand': { $regex: search, $options: 'i' } },
      { 'specifications.model': { $regex: search, $options: 'i' } }
    ];
  }

  // Only show approved auctions to non-moderators
  if (!req.user || !req.user.roles.includes('moderator')) {
    query['moderation.isApproved'] = true;
  }

  // Build sort
  let sortQuery = {};
  switch (sort) {
    case 'newest':
      sortQuery = { createdAt: -1 };
      break;
    case 'oldest':
      sortQuery = { createdAt: 1 };
      break;
    case 'ending_soon':
      sortQuery = { 'timing.endTime': 1 };
      break;
    case 'price_low':
      sortQuery = { 'pricing.currentBid': 1 };
      break;
    case 'price_high':
      sortQuery = { 'pricing.currentBid': -1 };
      break;
    case 'most_bids':
      sortQuery = { 'bidding.totalBids': -1 };
      break;
    default:
      sortQuery = { createdAt: -1 };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [auctions, total] = await Promise.all([
    Auction.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('seller.userId', 'anonymousId profile.reputation')
      .select('-seller.walletAddress -blockchain -moderation'),
    Auction.countDocuments(query)
  ]);

  // Add watcher status for authenticated users
  const auctionsWithWatchStatus = auctions.map(auction => {
    const auctionObj = auction.toObject();
    
    if (req.user) {
      auctionObj.isWatching = auction.watchers.some(w => 
        w.userId.toString() === req.user.userId
      );
    }
    
    return auctionObj;
  });

  logger.api('/auctions', 'GET', 200, { 
    query: req.query, 
    resultCount: auctions.length,
    userId: req.user?.userId 
  });

  res.json({
    success: true,
    message: 'Auctions retrieved successfully',
    data: {
      auctions: auctionsWithWatchStatus,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   GET /api/v1/auctions/search
// @desc    Search auctions
// @access  Public
router.get('/search', [
  query('q').notEmpty().withMessage('Search query is required'),
  query('category').optional().isString(),
  query('price_min').optional().isFloat({ min: 0 }),
  query('price_max').optional().isFloat({ min: 0 }),
  query('type').optional().isIn(['forward', 'reverse'])
], optionalAuth, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { q, category, price_min, price_max, type } = req.query;

  // Build search query
  const searchQuery = {
    status: 'active',
    'moderation.isApproved': true,
    $or: [
      { title: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } },
      { 'specifications.brand': { $regex: q, $options: 'i' } },
      { 'specifications.model': { $regex: q, $options: 'i' } },
      { category: { $regex: q, $options: 'i' } }
    ]
  };

  if (category) searchQuery.category = category;
  if (type) searchQuery.type = type;
  
  if (price_min || price_max) {
    searchQuery['pricing.currentBid'] = {};
    if (price_min) searchQuery['pricing.currentBid'].$gte = parseFloat(price_min);
    if (price_max) searchQuery['pricing.currentBid'].$lte = parseFloat(price_max);
  }

  const auctions = await Auction.find(searchQuery)
    .sort({ 'analytics.views': -1, createdAt: -1 })
    .limit(50)
    .populate('seller.userId', 'anonymousId profile.reputation')
    .select('-seller.walletAddress -blockchain -moderation');

  logger.api('/auctions/search', 'GET', 200, { 
    searchQuery: q, 
    resultCount: auctions.length 
  });

  res.json({
    success: true,
    message: 'Search completed successfully',
    data: {
      auctions,
      query: q,
      resultCount: auctions.length
    }
  });
}));

// @route   GET /api/v1/auctions/categories
// @desc    Get available categories
// @access  Public
router.get('/categories', asyncHandler(async (req, res) => {
  const categories = await Auction.aggregate([
    { $match: { status: 'active', 'moderation.isApproved': true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);

  res.json({
    success: true,
    message: 'Categories retrieved successfully',
    data: {
      categories: categories.map(cat => ({
        name: cat._id,
        count: cat.count
      }))
    }
  });
}));

// @route   GET /api/v1/auctions/featured
// @desc    Get featured auctions
// @access  Public
router.get('/featured', optionalAuth, asyncHandler(async (req, res) => {
  const featuredAuctions = await Auction.find({
    status: 'active',
    'moderation.isApproved': true,
    'analytics.views': { $gte: 100 },
    'bidding.totalBids': { $gte: 5 }
  })
    .sort({ 'analytics.views': -1, 'bidding.totalBids': -1 })
    .limit(10)
    .populate('seller.userId', 'anonymousId profile.reputation')
    .select('-seller.walletAddress -blockchain -moderation');

  res.json({
    success: true,
    message: 'Featured auctions retrieved successfully',
    data: {
      auctions: featuredAuctions
    }
  });
}));

// @route   GET /api/v1/auctions/:id
// @desc    Get specific auction details
// @access  Public
router.get('/:id', [
  param('id').isMongoId().withMessage('Invalid auction ID')
], optionalAuth, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const auction = await Auction.findById(req.params.id)
    .populate('seller.userId', 'anonymousId profile.reputation profile.memberSince')
    .populate('bidding.highestBidder.userId', 'anonymousId');

  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check if user can view this auction
  if (!auction.moderation.isApproved && 
      (!req.user || 
       (req.user.userId !== auction.seller.userId.toString() && 
        !req.user.roles.includes('moderator')))) {
    throw new NotFoundError('Auction not found');
  }

  // Increment view count (only for unique views)
  if (!req.user || req.user.userId !== auction.seller.userId.toString()) {
    await Auction.findByIdAndUpdate(req.params.id, {
      $inc: { 'analytics.views': 1 }
    });
  }

  // Get recent bids (anonymized)
  const recentBids = await Bid.find({ 'auction.auctionRef': auction._id })
    .sort({ 'timing.placedAt': -1 })
    .limit(10)
    .populate('bidder.userId', 'anonymousId')
    .select('amount timing.placedAt bidder.anonymousId status');

  // Check if user is watching
  let isWatching = false;
  if (req.user) {
    isWatching = auction.watchers.some(w => 
      w.userId.toString() === req.user.userId
    );
  }

  const auctionData = auction.toObject();
  
  // Remove sensitive data
  delete auctionData.seller.walletAddress;
  delete auctionData.blockchain;
  if (!req.user || !req.user.roles.includes('moderator')) {
    delete auctionData.moderation;
  }

  logger.auction('viewed', auction.auctionId, { 
    userId: req.user?.userId,
    viewerType: req.user ? 'authenticated' : 'anonymous'
  });

  res.json({
    success: true,
    message: 'Auction details retrieved successfully',
    data: {
      auction: {
        ...auctionData,
        isWatching,
        recentBids
      }
    }
  });
}));

// @route   POST /api/v1/auctions
// @desc    Create new auction
// @access  Private
router.post('/', [
  auth,
  uploadMultiple('images', 10), // Allow up to 10 images
  body('title').trim().isLength({ min: 5, max: 200 }).withMessage('Title must be between 5 and 200 characters'),
  body('description').trim().isLength({ min: 20, max: 2000 }).withMessage('Description must be between 20 and 2000 characters'),
  body('category').isIn(['electronics', 'fashion', 'home-garden', 'sports', 'automotive', 'books', 'art', 'collectibles', 'services', 'other']).withMessage('Invalid category'),
  body('type').optional().isIn(['forward', 'reverse']).withMessage('Invalid auction type'),
  body('startingBid').isFloat({ min: 0.01 }).withMessage('Starting bid must be greater than 0'),
  body('reservePrice').optional().isFloat({ min: 0 }).withMessage('Reserve price must be non-negative'),
  body('buyNowPrice').optional().isFloat({ min: 0 }).withMessage('Buy now price must be non-negative'),
  body('duration').isInt({ min: 3600000, max: 2592000000 }).withMessage('Duration must be between 1 hour and 30 days (in milliseconds)'),
  body('condition').isIn(['new', 'like-new', 'good', 'fair', 'poor']).withMessage('Invalid condition'),
  body('shippingMethod').optional().isIn(['pickup', 'standard', 'express', 'digital']).withMessage('Invalid shipping method'),
  body('shippingCost').optional().isFloat({ min: 0 }).withMessage('Shipping cost must be non-negative')
], require('../controllers/auctionController').createAuction);
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const {
    title,
    description,
    category,
    type = 'forward',
    startingBid,
    reservePrice = 0,
    buyNowPrice = 0,
    duration,
    condition,
    brand,
    model,
    year,
    shippingMethod = 'standard',
    shippingCost = 0,
    images = []
  } = req.body;

  // Validate reserve price vs starting bid
  if (reservePrice > 0 && reservePrice < startingBid) {
    throw new ValidationError('Reserve price cannot be less than starting bid');
  }

  // Validate buy now price
  if (buyNowPrice > 0 && buyNowPrice <= Math.max(startingBid, reservePrice)) {
    throw new ValidationError('Buy now price must be greater than starting bid and reserve price');
  }

  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + parseInt(duration));

  const auction = new Auction({
    title,
    description,
    category,
    type,
    seller: {
      userId: req.user.userId,
      anonymousId: req.user.anonymousId,
      walletAddress: req.user.walletAddress
    },
    pricing: {
      startingBid,
      currentBid: type === 'reverse' ? startingBid : 0,
      reservePrice,
      buyNowPrice
    },
    timing: {
      startTime,
      endTime,
      duration: parseInt(duration)
    },
    images,
    specifications: {
      condition,
      brand,
      model,
      year
    },
    shipping: {
      method: shippingMethod,
      cost: shippingCost
    },
    status: 'draft' // Will be pending after blockchain creation
  });

  await auction.save();

  try {
    // Create auction on blockchain
    const blockchainResult = await web3Service.createAuctionOnChain(
      title,
      description,
      startingBid,
      reservePrice,
      buyNowPrice,
      parseInt(duration) / 1000, // Convert to seconds
      type === 'reverse'
    );

    // Update auction with blockchain info
    auction.blockchain.contractAddress = process.env.AUCTION_CONTRACT_ADDRESS;
    auction.blockchain.transactionHash = blockchainResult.transactionHash;
    auction.blockchain.blockNumber = blockchainResult.blockNumber;
    auction.blockchain.isOnChain = true;
    auction.status = 'pending'; // Now pending approval
    await auction.save();

    logger.auction('created_on_blockchain', auction.auctionId, {
      userId: req.user.userId,
      blockchainAuctionId: blockchainResult.auctionId,
      transactionHash: blockchainResult.transactionHash
    });

  } catch (blockchainError) {
    logger.error('Failed to create auction on blockchain:', blockchainError);
    
    // Mark auction as failed
    auction.status = 'cancelled';
    await auction.save();
    
    return res.status(400).json({
      success: false,
      message: 'Failed to create auction on blockchain',
      data: null
    });
  }
  // Update user's auction count
  await User.findByIdAndUpdate(req.user.userId, {
    $inc: { 'profile.totalAuctions': 1 }
  });

  logger.auction('created', auction.auctionId, {
    userId: req.user.userId,
    title,
    category,
    startingBid
  });

  res.status(201).json({
    success: true,
    message: 'Auction created on blockchain and pending approval',
    data: {
      auction: {
        id: auction._id,
        auctionId: auction.auctionId,
        title: auction.title,
        status: auction.status,
        blockchainTxHash: auction.blockchain.transactionHash,
        createdAt: auction.createdAt
      }
    }
  });
}));

// @route   PUT /api/v1/auctions/:id
// @desc    Update auction (owner only, before it starts)
// @access  Private
router.put('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid auction ID'),
  body('title').optional().trim().isLength({ min: 5, max: 200 }),
  body('description').optional().trim().isLength({ min: 20, max: 2000 }),
  body('reservePrice').optional().isFloat({ min: 0 }),
  body('buyNowPrice').optional().isFloat({ min: 0 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const auction = await Auction.findById(req.params.id);
  
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check ownership
  if (auction.seller.userId.toString() !== req.user.userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - not auction owner',
      data: null
    });
  }

  // Check if auction can be modified
  if (auction.status !== 'draft' && auction.status !== 'pending') {
    return res.status(400).json({
      success: false,
      message: 'Cannot modify auction after it has started',
      data: null
    });
  }

  // Update allowed fields
  const allowedUpdates = ['title', 'description', 'reservePrice', 'buyNowPrice', 'images', 'specifications', 'shipping'];
  const updates = {};
  
  allowedUpdates.forEach(field => {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  });

  const updatedAuction = await Auction.findByIdAndUpdate(
    req.params.id,
    { $set: updates },
    { new: true, runValidators: true }
  );

  logger.auction('updated', auction.auctionId, {
    userId: req.user.userId,
    updates: Object.keys(updates)
  });

  res.json({
    success: true,
    message: 'Auction updated successfully',
    data: {
      auction: updatedAuction
    }
  });
}));

// @route   DELETE /api/v1/auctions/:id
// @desc    Delete auction (owner only, before it starts)
// @access  Private
router.delete('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid auction ID')
], asyncHandler(async (req, res) => {
  const auction = await Auction.findById(req.params.id);
  
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check ownership
  if (auction.seller.userId.toString() !== req.user.userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - not auction owner',
      data: null
    });
  }

  // Check if auction can be deleted
  if (auction.status === 'active' && auction.bidding.totalBids > 0) {
    return res.status(400).json({
      success: false,
      message: 'Cannot delete auction with active bids',
      data: null
    });
  }

  await Auction.findByIdAndDelete(req.params.id);

  // Update user's auction count
  await User.findByIdAndUpdate(req.user.userId, {
    $inc: { 'profile.totalAuctions': -1 }
  });

  logger.auction('deleted', auction.auctionId, {
    userId: req.user.userId
  });

  res.json({
    success: true,
    message: 'Auction deleted successfully',
    data: null
  });
}));

// @route   POST /api/v1/auctions/:id/close
// @desc    Close auction manually (owner only)
// @access  Private
router.post('/:id/close', [
  auth,
  param('id').isMongoId().withMessage('Invalid auction ID')
], asyncHandler(async (req, res) => {
  const auction = await Auction.findById(req.params.id);
  
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check ownership
  if (auction.seller.userId.toString() !== req.user.userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - not auction owner',
      data: null
    });
  }

  // Check if auction can be closed
  if (auction.status !== 'active') {
    return res.status(400).json({
      success: false,
      message: 'Only active auctions can be closed',
      data: null
    });
  }

  // End the auction
  await auction.endAuction();

  // Notify participants
  if (socketService) {
    socketService.broadcastAuctionEnd(auction.auctionId, {
      auctionId: auction.auctionId,
      winner: auction.winner,
      endedBy: 'seller'
    });
  }

  logger.auction('closed_manually', auction.auctionId, {
    userId: req.user.userId,
    winner: auction.winner?.anonymousId
  });

  res.json({
    success: true,
    message: 'Auction closed successfully',
    data: {
      auction: {
        id: auction._id,
        auctionId: auction.auctionId,
        status: auction.status,
        winner: auction.winner
      }
    }
  });
}));

// @route   POST /api/v1/auctions/:id/bids
// @desc    Place new bid
// @access  Private
router.post('/:id/bids', [
  auth,
  biddingLimiter, // Apply bidding rate limit
  param('id').isMongoId().withMessage('Invalid auction ID'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Bid amount must be greater than 0'),
  body('isAutoBid').optional().isBoolean(),
  body('maxAmount').optional().isFloat({ min: 0 }),
  body('increment').optional().isFloat({ min: 0 })
], require('../controllers/bidController').placeBid);
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { amount, isAutoBid = false, maxAmount, increment } = req.body;
  const auctionId = req.params.id;

  // Find auction
  const auction = await Auction.findById(auctionId);
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check if auction is active
  if (auction.status !== 'active') {
    return res.status(400).json({
      success: false,
      message: 'Auction is not active',
      data: null
    });
  }

  // Check if auction has ended
  if (new Date() >= auction.timing.endTime) {
    return res.status(400).json({
      success: false,
      message: 'Auction has ended',
      data: null
    });
  }

  // Check if user is not the seller
  if (auction.seller.userId.toString() === req.user.userId) {
    return res.status(400).json({
      success: false,
      message: 'Cannot bid on your own auction',
      data: null
    });
  }

  // Validate bid amount
  const minBidAmount = auction.pricing.currentBid + (auction.bidding.bidIncrement || 1);
  if (amount < minBidAmount) {
    return res.status(400).json({
      success: false,
      message: `Bid must be at least ${minBidAmount} tokens`,
      data: null
    });
  }

  // Create bid
  const bid = new Bid({
    auction: {
      auctionId: auction.auctionId,
      auctionRef: auction._id
    },
    bidder: {
      userId: req.user.userId,
      anonymousId: req.user.anonymousId,
      walletAddress: req.user.walletAddress
    },
    amount,
    autoBid: {
      isAutoBid,
      maxAmount,
      increment,
      isActive: isAutoBid
    },
    metadata: {
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      bidSource: 'web'
    }
  });

  await bid.save();

  try {
    // Simulate blockchain transaction
    const lockResult = {
      transactionHash: `0x${require('crypto').randomBytes(32).toString('hex')}`,
      blockNumber: Math.floor(Math.random() * 1000000),
      gasUsed: Math.floor(Math.random() * 100000)
    };

    // Update bid with blockchain info
    bid.blockchain.transactionHash = lockResult.transactionHash;
    bid.blockchain.blockNumber = lockResult.blockNumber;
    bid.blockchain.isOnChain = true;
    bid.status = 'active';
    await bid.save();

    // Mark previous highest bidder as outbid
    if (auction.bidding.highestBidder.userId) {
      await Bid.updateMany(
        {
          'auction.auctionRef': auction._id,
          'bidder.userId': auction.bidding.highestBidder.userId,
          status: 'winning'
        },
        { status: 'outbid' }
      );
    }

    // Update auction with new highest bid
    await auction.placeBid(amount, {
      userId: req.user.userId,
      anonymousId: req.user.anonymousId,
      walletAddress: req.user.walletAddress
    });

    // Mark current bid as winning
    bid.status = 'winning';
    await bid.save();

    // Create token transaction record
    const tokenTransaction = new TokenTransaction({
      type: 'bid_lock',
      user: {
        userId: req.user.userId,
        walletAddress: req.user.walletAddress,
        anonymousId: req.user.anonymousId
      },
      amount,
      blockchain: {
        transactionHash: lockResult.transactionHash,
        blockNumber: lockResult.blockNumber,
        gasUsed: lockResult.gasUsed
      },
      relatedTo: {
        type: 'bid',
        id: bid.bidId,
        reference: bid._id
      },
      status: 'confirmed'
    });

    await tokenTransaction.save();

    // Broadcast bid update via WebSocket
    if (socketService) {
      socketService.broadcastBidUpdate(auction.auctionId, {
        bidId: bid.bidId,
        bidder: bid.bidder.anonymousId,
        amount: bid.amount,
        isNewHighest: true
      });
    }

    logger.auction('bid_placed', auction.auctionId, {
      bidId: bid.bidId,
      userId: req.user.userId,
      amount,
      transactionHash: lockResult.transactionHash
    });

    res.status(201).json({
      success: true,
      message: 'Bid placed successfully',
      data: {
        bid: {
          id: bid._id,
          bidId: bid.bidId,
          amount: bid.amount,
          status: bid.status,
          placedAt: bid.timing.placedAt,
          transactionHash: lockResult.transactionHash
        }
      }
    });

  } catch (blockchainError) {
    // If blockchain transaction fails, mark bid as failed
    bid.status = 'cancelled';
    bid.validation.isValid = false;
    bid.validation.validationErrors.push('Blockchain transaction failed');
    await bid.save();

    logger.error('Blockchain bid placement failed:', blockchainError);
    
    res.status(400).json({
      success: false,
      message: 'Failed to submit bid to blockchain',
      data: null
    });
  }
}));

// @route   GET /api/v1/auctions/:id/bids
// @desc    Get all bids for auction (anonymized)
// @access  Public
router.get('/:id/bids', [
  param('id').isMongoId().withMessage('Invalid auction ID'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], optionalAuth, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Find auction
  const auction = await Auction.findById(req.params.id);
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Get bids (anonymized for public view)
  const bids = await Bid.find({ 'auction.auctionRef': auction._id })
    .sort({ amount: -1, 'timing.placedAt': -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .select('bidId amount timing.placedAt status bidder.anonymousId');

  const total = await Bid.countDocuments({ 'auction.auctionRef': auction._id });

  res.json({
    success: true,
    message: 'Auction bids retrieved successfully',
    data: {
      bids,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));
// @route   POST /api/v1/auctions/:id/watch
// @desc    Add auction to watchlist
// @access  Private
router.post('/:id/watch', [
  auth,
  param('id').isMongoId().withMessage('Invalid auction ID')
], asyncHandler(async (req, res) => {
  const auction = await Auction.findById(req.params.id);
  
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  await auction.addWatcher(req.user.userId);

  // Notify auction room
  if (socketService) {
    socketService.broadcastToAuction(auction.auctionId, 'auction_watched', {
      watcherCount: auction.analytics.watchersCount + 1
    });
  }

  logger.auction('watched', auction.auctionId, {
    userId: req.user.userId
  });

  res.json({
    success: true,
    message: 'Auction added to watchlist',
    data: null
  });
}));

// @route   DELETE /api/v1/auctions/:id/watch
// @desc    Remove auction from watchlist
// @access  Private
router.delete('/:id/watch', [
  auth,
  param('id').isMongoId().withMessage('Invalid auction ID')
], asyncHandler(async (req, res) => {
  const auction = await Auction.findById(req.params.id);
  
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  await auction.removeWatcher(req.user.userId);

  // Notify auction room
  if (socketService) {
    socketService.broadcastToAuction(auction.auctionId, 'auction_unwatched', {
      watcherCount: Math.max(0, auction.analytics.watchersCount - 1)
    });
  }

  logger.auction('unwatched', auction.auctionId, {
    userId: req.user.userId
  });

  res.json({
    success: true,
    message: 'Auction removed from watchlist',
    data: null
  });
}));

module.exports = router;