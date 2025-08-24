const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const TokenTransaction = require('../models/tokenTransactionModel');
const User = require('../models/userModel');
const { auth } = require('../middleware/auth');
const { asyncHandler, formatValidationErrors, ValidationError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const router = express.Router();

// @route   GET /api/v1/payments/methods
// @desc    Get available payment methods
// @access  Private
router.get('/methods', auth, asyncHandler(async (req, res) => {
  const paymentMethods = [
    {
      id: 'mtn_momo',
      name: 'MTN Mobile Money',
      type: 'mobile_money',
      status: 'active',
      fees: {
        percentage: 1.5,
        minimum: 0.5,
        maximum: 50
      },
      limits: {
        minimum: 10,
        maximum: 10000,
        daily: 50000
      },
      processingTime: 'instant',
      countries: ['GH']
    },
    {
      id: 'vodafone_cash',
      name: 'Vodafone Cash',
      type: 'mobile_money',
      status: 'active',
      fees: {
        percentage: 1.8,
        minimum: 0.5,
        maximum: 50
      },
      limits: {
        minimum: 10,
        maximum: 10000,
        daily: 50000
      },
      processingTime: 'instant',
      countries: ['GH']
    },
    {
      id: 'airteltigo',
      name: 'AirtelTigo Money',
      type: 'mobile_money',
      status: 'maintenance',
      fees: {
        percentage: 2.0,
        minimum: 0.5,
        maximum: 50
      },
      limits: {
        minimum: 10,
        maximum: 5000,
        daily: 25000
      },
      processingTime: '1-5 minutes',
      countries: ['GH']
    },
    {
      id: 'telecel_cash',
      name: 'Telecel Cash',
      type: 'mobile_money',
      status: 'active',
      fees: {
        percentage: 1.7,
        minimum: 0.5,
        maximum: 50
      },
      limits: {
        minimum: 10,
        maximum: 8000,
        daily: 40000
      },
      processingTime: 'instant',
      countries: ['GH']
    },
    {
      id: 'visa_mastercard',
      name: 'Visa/Mastercard',
      type: 'bank_card',
      status: 'active',
      fees: {
        percentage: 2.9,
        minimum: 1.0,
        maximum: 100
      },
      limits: {
        minimum: 50,
        maximum: 50000,
        daily: 100000
      },
      processingTime: '2-3 minutes',
      countries: ['GH', 'NG', 'KE', 'ZA']
    }
  ];

  res.json({
    success: true,
    message: 'Payment methods retrieved successfully',
    data: {
      paymentMethods
    }
  });
}));

// @route   POST /api/v1/payments/process
// @desc    Process payment
// @access  Private
router.post('/process', [
  auth,
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1'),
  body('paymentMethod').isString().withMessage('Payment method is required'),
  body('type').isIn(['deposit', 'withdrawal']).withMessage('Invalid payment type'),
  body('phoneNumber').optional().isMobilePhone('any'),
  body('accountDetails').optional().isObject()
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { amount, paymentMethod, type, phoneNumber, accountDetails } = req.body;

  // Validate payment method
  const validMethods = ['mtn_momo', 'vodafone_cash', 'airteltigo', 'telecel_cash', 'visa_mastercard'];
  if (!validMethods.includes(paymentMethod)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payment method',
      data: null
    });
  }

  // For withdrawals, check balance
  if (type === 'withdrawal') {
    const balanceSummary = await TokenTransaction.getUserBalanceSummary(req.user.userId);
    if (balanceSummary.available < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        data: null
      });
    }
  }

  // Create transaction record
  const transaction = new TokenTransaction({
    type,
    user: {
      userId: req.user.userId,
      walletAddress: req.user.walletAddress,
      anonymousId: req.user.anonymousId
    },
    amount: type === 'withdrawal' ? -amount : amount,
    status: 'pending',
    mobileMoneyIntegration: {
      provider: paymentMethod,
      phoneNumber,
      exchangeRate: 1.0,
      localAmount: amount,
      localCurrency: 'GHS'
    },
    metadata: {
      source: 'web',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      initiatedBy: 'user',
      description: `${type} via ${paymentMethod}`
    }
  });

  await transaction.save();

  // Here you would integrate with actual payment processors
  // For simulation, we'll mark as processing
  setTimeout(async () => {
    try {
      // Simulate payment processing
      transaction.status = 'confirmed';
      transaction.blockchain.transactionHash = `0x${require('crypto').randomBytes(32).toString('hex')}`;
      transaction.blockchain.blockNumber = await web3Service.getCurrentBlockNumber();
      transaction.blockchain.isConfirmed = true;
      await transaction.save();

      logger.payment(`${type}_completed`, amount, 'WKC', {
        userId: req.user.userId,
        transactionId: transaction.transactionId
      });
    } catch (error) {
      logger.error(`Payment ${type} simulation error:`, error);
    }
  }, 5000); // Simulate 5 second processing time

  logger.payment(`${type}_initiated`, amount, 'WKC', {
    userId: req.user.userId,
    paymentMethod,
    transactionId: transaction.transactionId
  });

  res.status(201).json({
    success: true,
    message: `${type} initiated successfully`,
    data: {
      transaction: {
        id: transaction._id,
        transactionId: transaction.transactionId,
        amount: transaction.amount,
        status: transaction.status,
        paymentMethod,
        estimatedCompletion: '2-5 minutes',
        createdAt: transaction.createdAt
      }
    }
  });
}));

// @route   GET /api/v1/payments/:id/status
// @desc    Check payment status
// @access  Private
router.get('/:transactionId/status', [
  auth,
  param('transactionId').isString().withMessage('Invalid transaction ID')
], asyncHandler(async (req, res) => {
  const transaction = await TokenTransaction.findOne({ 
    transactionId: req.params.transactionId,
    'user.userId': req.user.userId
  });

  if (!transaction) {
    return res.status(404).json({
      success: false,
      message: 'Transaction not found',
      data: null
    });
  }

  res.json({
    success: true,
    message: 'Transaction status retrieved successfully',
    data: {
      transaction: {
        transactionId: transaction.transactionId,
        type: transaction.type,
        amount: transaction.amount,
        status: transaction.status,
        blockchain: {
          transactionHash: transaction.blockchain.transactionHash,
          confirmations: transaction.blockchain.confirmations,
          isConfirmed: transaction.blockchain.isConfirmed
        },
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt
      }
    }
  });
}));

// @route   GET /api/v1/payments/history
// @desc    Get payment history
// @access  Private
router.get('/history', [
  auth,
  query('type').optional().isIn(['deposit', 'withdrawal']),
  query('status').optional().isIn(['pending', 'confirmed', 'failed', 'cancelled']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { type, status, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const query = { 
    'user.userId': req.user.userId,
    type: { $in: ['deposit', 'withdrawal'] }
  };
  
  if (type) query.type = type;
  if (status) query.status = status;

  const [transactions, total] = await Promise.all([
    TokenTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-user.walletAddress -blockchain.blockHash'),
    TokenTransaction.countDocuments(query)
  ]);

  res.json({
    success: true,
    message: 'Payment history retrieved successfully',
    data: {
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

module.exports = router;