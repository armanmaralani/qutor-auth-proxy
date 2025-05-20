const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const axios = require('axios'); // ← برای ارسال درخواست به OpenAI

// 🔐 بارگذاری کلید API از محیط
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-xxxxxxxxxxxxxxxx'; // ← این مقدار را از env بگیر یا دستی وارد کن

// 🔐 Firebase Admin Initialization
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 3000;

// 🔐 MongoDB Atlas Connection
const uri = 'mongodb+srv://qutor:14arman69@cluster0.3wz5uni.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri);
let usersCollection;

// اتصال به MongoDB
async function connectToMongo() {
  try {
    await client.connect();
    const db = client.db('qutor-app');
    usersCollection = db.collection('users');
    console.log('✅ Connected to MongoDB Atlas');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  }
}
connectToMongo();

// ✅ لیست سفید شماره‌های ویژه
const whitelist = ['+989123456789', '+989365898911']; // ← شماره خودت اینجا قرار بگیره

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Root
app.get('/', (req, res) => {
  res.send('✅ Qutor Firebase Proxy + MongoDB is running');
});

// ✅ مسیر ارسال سؤال به OpenAI از طریق سرور واسط
app.post('/chat', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ message: '❌ سوالی دریافت نشد' });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'شما یک معلم باتجربه هستی که گام‌به‌گام به دانش‌آموزان راه‌حل‌ها را آموزش می‌دهی.'
          },
          { role: 'user', content: question }
        ],
        temperature: 0.4,
        max_tokens: 1000
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const answer = response.data.choices[0].message.content;
    res.json({ answer: answer.trim() });
  } catch (err) {
    console.error('❌ خطا در دریافت پاسخ از OpenAI:', err.response?.data || err.message);
    res.status(500).json({ message: '❌ خطا در پردازش سؤال', error: err.message });
  }
});

// ✅ ارسال OTP و ذخیره کاربر جدید
app.post('/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  try {
    const userRecord = await admin.auth().getUserByPhoneNumber(phoneNumber);
    const uid = userRecord.uid;

    const existing = await usersCollection.findOne({ phoneNumber });
    if (!existing) {
      await usersCollection.insertOne({
        phoneNumber,
        uid,
        createdAt: new Date(),
        usedFreeQuestions: 0,
      });
      console.log(`✅ شماره جدید ذخیره شد: ${phoneNumber}`);
    } else {
      console.log(`⚠️ شماره قبلاً ذخیره شده: ${phoneNumber}`);
    }

    res.json({ message: '✅ کاربر در Firebase وجود دارد', uid });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ message: '❌ کاربر در Firebase یافت نشد' });
    }
    console.error('🔥 Firebase Error:', error.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: error.message });
  }
});

// ✅ بررسی پر بودن اطلاعات کاربر
app.post('/check-user-info', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره وارد نشده است' });

  try {
    const user = await usersCollection.findOne({ phoneNumber });
    const isFilled =
      user && user.name && user.lastName && user.age && user.gender && user.field;

    res.json({ exists: !!isFilled });
  } catch (err) {
    console.error('❌ خطا در بررسی اطلاعات کاربر:', err);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

// ✅ بررسی سهمیه سؤال رایگان
app.post('/check-quota', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  if (whitelist.includes(phoneNumber)) {
    return res.json({ allowed: true, message: '✅ این شماره در لیست سفید است' });
  }

  try {
    const user = await usersCollection.findOne({ phoneNumber });
    const used = user?.usedFreeQuestions || 0;

    if (used < 5) {
      res.json({ allowed: true, used });
    } else {
      res.json({ allowed: false, used });
    }
  } catch (err) {
    console.error('❌ خطا در بررسی سهمیه:', err);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

// ✅ افزایش تعداد استفاده پس از ارسال موفق سؤال
app.post('/increment-usage', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره وارد نشده' });

  if (whitelist.includes(phoneNumber)) {
    return res.json({ skipped: true, message: '🔓 شماره در لیست سفید است - نیازی به آپدیت نیست' });
  }

  try {
    const result = await usersCollection.updateOne(
      { phoneNumber },
      { $inc: { usedFreeQuestions: 1 } }
    );

    if (result.modifiedCount === 1) {
      res.json({ success: true, message: '✅ تعداد سؤال‌ها آپدیت شد' });
    } else {
      res.json({ success: false, message: '⚠️ شماره یافت نشد یا تغییری نکرد' });
    }
  } catch (err) {
    console.error('❌ خطا در افزایش سؤال:', err);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
