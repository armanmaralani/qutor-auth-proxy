const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const axios = require('axios');

// 🔐 بارگذاری کلیدهای API از متغیرهای محیطی
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_KEY_JSON = process.env.FIREBASE_KEY;

if (!OPENAI_API_KEY || !FIREBASE_KEY_JSON) {
  console.error('❌ کلید OpenAI یا Firebase در محیط تنظیم نشده');
  process.exit(1);
}

let firebaseConfig;
try {
  firebaseConfig = JSON.parse(FIREBASE_KEY_JSON);
} catch (err) {
  console.error('❌ کلید Firebase معتبر نیست یا ساختار JSON اشتباه است');
  process.exit(1);
}

// 🔐 مقداردهی Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

// 💾 اتصال به MongoDB Atlas
const uri = 'mongodb+srv://qutor:14arman69@cluster0.3wz5uni.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri);
let usersCollection;

async function connectToMongo() {
  try {
    await client.connect();
    usersCollection = client.db('qutor-app').collection('users');
    console.log('✅ MongoDB متصل شد');
  } catch (err) {
    console.error('❌ MongoDB Error:', err.message);
    process.exit(1);
  }
}
connectToMongo();

const app = express();
const port = process.env.PORT || 3000;

// 🔒 شماره‌های مجاز
const whitelist = ['+989123456789', '+989365898911'];

app.use(cors());
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

app.post('/chat', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ message: '❌ سوال دریافت نشد' });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'شما یک معلم باتجربه هستید که گام‌به‌گام به دانش‌آموز کمک می‌کنید.' },
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
    res.json({ answer: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error('❌ OpenAI Error:', err.response?.data || err.message);
    res.status(500).json({ message: '❌ خطا در پردازش سؤال', error: err.message });
  }
});

app.post('/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  try {
    const userRecord = await admin.auth().getUserByPhoneNumber(phoneNumber);
    const uid = userRecord.uid;

    const existing = await usersCollection.findOne({ phoneNumber });
    if (!existing) {
      await usersCollection.insertOne({ phoneNumber, uid, createdAt: new Date(), usedFreeQuestions: 0 });
      console.log(`✅ شماره جدید ثبت شد: ${phoneNumber}`);
    }

    res.json({ message: '✅ کاربر وجود دارد', uid });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ message: '❌ کاربر یافت نشد' });
    }
    console.error('🔥 Firebase Error:', error.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: error.message });
  }
});

app.post('/check-user-info', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  try {
    const user = await usersCollection.findOne({ phoneNumber });
    const isFilled = user && user.name && user.lastName && user.age && user.gender && user.field;
    res.json({ exists: !!isFilled });
  } catch (err) {
    console.error('❌ بررسی اطلاعات کاربر:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

app.post('/check-quota', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  if (whitelist.includes(phoneNumber)) {
    return res.json({ allowed: true, message: '✅ شماره در لیست سفید است' });
  }

  try {
    const user = await usersCollection.findOne({ phoneNumber });
    const used = user?.usedFreeQuestions || 0;
    res.json({ allowed: used < 5, used });
  } catch (err) {
    console.error('❌ بررسی سهمیه:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

app.post('/increment-usage', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ message: '❌ شماره ارسال نشده' });

  if (whitelist.includes(phoneNumber)) {
    return res.json({ skipped: true, message: '✅ شماره در لیست سفید است' });
  }

  try {
    const result = await usersCollection.updateOne(
      { phoneNumber },
      { $inc: { usedFreeQuestions: 1 } }
    );
    res.json({ success: result.modifiedCount === 1 });
  } catch (err) {
    console.error('❌ افزایش سهمیه:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
});
