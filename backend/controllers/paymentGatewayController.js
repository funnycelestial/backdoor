// controllers/paymentGatewayController.js
import PaymentGateway from '../models/paymentGatewayModel.js';
import TokenTransaction from '../models/tokentransactionModel.js';
import User from '../models/userModel.js';
import { processPayment, processPayout } from '../services/paymentProcessors.js';
import { notifyUser } from '../services/notificationService.js';

// Constants
const TOKEN_RATE = 5; // 1 GHS = 5 tokens (adjust based on your economy)
const SELL_RATE = 0.18; // 1 token = 0.18 GHS when cashing out

// 1. Initiate Token Purchase
export const buyTokens = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { method, amountFiat } = req.body;
    const amountTokens = amountFiat * TOKEN_RATE;

    // Create payment record
    const payment = await PaymentGateway.create([{
      user: req.user.id,
      type: 'BUY_TOKENS',
      method,
      amountFiat,
      amountTokens,
      status: 'PENDING',
      transactionRef: `init_${Date.now()}`
    }], { session });

    // Initiate payment with processor
    const paymentResult = await processPayment({
      userId: req.user.id,
      method,
      amount: amountFiat,
      reference: payment[0].transactionRef
    });

    if (!paymentResult.success) {
      await session.abortTransaction();
      return res.status(400).json({ message: paymentResult.error });
    }

    // Update payment record with processor reference
    await PaymentGateway.updateOne(
      { _id: payment[0]._id },
      { transactionRef: paymentResult.processorId },
      { session }
    );

    await session.commitTransaction();

    res.json({
      paymentId: payment[0]._id,
      nextAction: paymentResult.nextStep // e.g., "REDIRECT_TO_MOMO" or "CONFIRM_PAYMENT"
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Payment initiation failed: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};

// 2. Confirm Token Purchase (Webhook Handler)
export const confirmPurchase = async (processorId, amountReceived) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const payment = await PaymentGateway.findOneAndUpdate(
      { transactionRef: processorId, status: 'PENDING' },
      { 
        status: 'COMPLETED',
        amountFiat: amountReceived, // In case of partial payments
        notes: 'Verified via payment processor webhook'
      },
      { new: true, session }
    );

    if (!payment) {
      await session.abortTransaction();
      throw new Error('Payment record not found');
    }

    // Credit user tokens
    await User.findByIdAndUpdate(
      payment.user,
      { $inc: { balance: payment.amountTokens } },
      { session }
    );

    // Record token transaction
    await TokenTransaction.create([{
      user: payment.user,
      type: 'TOKEN_PURCHASE',
      amount: payment.amountTokens,
      status: 'SUCCESS',
      linkedPayment: payment._id
    }], { session });

    await session.commitTransaction();

    // Notify user
    await notifyUser(payment.user, 'TOKENS_CREDITED', {
      amount: payment.amountTokens,
      method: payment.method
    });

    return { success: true };

  } catch (error) {
    await session.abortTransaction();
    console.error('Purchase confirmation failed:', error);
    return { success: false, error: error.message };
  } finally {
    session.endSession();
  }
};

// 3. Initiate Token Sell-Out
export const sellTokens = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { method, amountTokens } = req.body;
    const amountFiat = amountTokens * SELL_RATE;

    // Validate balance
    const user = await User.findById(req.user.id).session(session);
    if (user.balance < amountTokens) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Insufficient token balance' });
    }

    // Deduct tokens immediately
    await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { balance: -amountTokens } },
      { session }
    );

    // Create payout record
    const payout = await PaymentGateway.create([{
      user: req.user.id,
      type: 'SELL_TOKENS',
      method,
      amountFiat,
      amountTokens,
      status: 'PENDING',
      transactionRef: `payout_${Date.now()}`
    }], { session });

    // Record token debit
    await TokenTransaction.create([{
      user: req.user.id,
      type: 'TOKEN_SELL',
      amount: -amountTokens,
      status: 'PENDING',
      linkedPayment: payout[0]._id
    }], { session });

    // Initiate payout
    const payoutResult = await processPayout({
      userId: req.user.id,
      method,
      amount: amountFiat,
      reference: payout[0].transactionRef
    });

    if (!payoutResult.success) {
      await session.abortTransaction();
      return res.status(400).json({ message: payoutResult.error });
    }

    await session.commitTransaction();

    res.json({
      payoutId: payout[0]._id,
      estimatedProcessing: payoutResult.eta
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ 
      message: 'Payout initiation failed: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    session.endSession();
  }
};

// 4. Confirm Token Sell-Out (Webhook Handler)
export const confirmPayout = async (processorId) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const payout = await PaymentGateway.findOneAndUpdate(
      { transactionRef: processorId, status: 'PENDING' },
      { status: 'COMPLETED' },
      { new: true, session }
    );

    if (!payout) {
      await session.abortTransaction();
      throw new Error('Payout record not found');
    }

    // Update token transaction status
    await TokenTransaction.updateOne(
      { linkedPayment: payout._id },
      { status: 'SUCCESS' },
      { session }
    );

    await session.commitTransaction();

    await notifyUser(payout.user, 'FIAT_PAYOUT_COMPLETED', {
      amount: payout.amountFiat,
      method: payout.method
    });

    return { success: true };

  } catch (error) {
    await session.abortTransaction();
    console.error('Payout confirmation failed:', error);
    return { success: false, error: error.message };
  } finally {
    session.endSession();
  }
};

// 5. Admin Endpoints
export const listTransactions = async (req, res) => {
  try {
    const { method, status, userId, type } = req.query;
    const filter = {};
    if (method) filter.method = method;
    if (status) filter.status = status;
    if (userId) filter.user = userId;
    if (type) filter.type = type;

    const transactions = await PaymentGateway.find(filter)
      .populate('user', 'username email')
      .sort({ createdAt: -1 });

    res.json(transactions);
  } catch (error) {
    res.status(500).json({ message: 'Fetch failed: ' + error.message });
  }
};

export const updateTransactionStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { status, notes } = req.body;
    const transaction = await PaymentGateway.findByIdAndUpdate(
      req.params.id,
      { status, notes },
      { new: true, session }
    );

    // Handle refunds if marking as FAILED/CANCELLED
    if (status === 'FAILED' && transaction.type === 'BUY_TOKENS') {
      await TokenTransaction.deleteOne(
        { linkedPayment: transaction._id },
        { session }
      );
    }

    if (status === 'FAILED' && transaction.type === 'SELL_TOKENS') {
      await User.findByIdAndUpdate(
        transaction.user,
        { $inc: { balance: transaction.amountTokens } },
        { session }
      );
    }

    await session.commitTransaction();
    res.json(transaction);

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ message: 'Update failed: ' + error.message });
  } finally {
    session.endSession();
  }
};