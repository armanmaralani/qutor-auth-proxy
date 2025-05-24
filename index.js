const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const axios = require('axios');

console.log("Starting server...");

// هندل خطاهای کلی
process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// بارگذاری کلید OpenAI فقط از محیط
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ کلید OpenAI در محیط تنظیم نشده');
  process.exit(1);
}

// بارگذاری کلید Firebase با تشخیص محیط اجرا
let firebaseConfig;
try {
  if (process.env.RENDER === 'true') {
    firebaseConfig = require('/etc/secrets/firebase-key.json');
  } else {
    firebaseConfig = require('./firebase-key.json');
  }
} catch (err) {
  console.error('❌ فایل firebase-key.json یافت نشد یا مشکل دارد:', err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

// اتصال به دیتابیس MongoDB Atlas
const uri = 'mongodb+srv://qutor:armanMaralani@cluster0.3wz5uni.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri);
let usersCollection;
let sourcesCollection;

async function connectToMongo() {
  try {
    await client.connect();
    usersCollection = client.db('qutor-app').collection('users');
    sourcesCollection = client.db('qutor-app').collection('sources');
    console.log('✅ MongoDB متصل شد');
  } catch (err) {
    console.error('❌ MongoDB Error:', err.message);
    process.exit(1);
  }
}
connectToMongo();

const app = express();
const port = process.env.PORT || 10000;
console.log(`🚀 Server will run on port: ${port}`);

const whitelist = ['+989123456789', '+989365898911'];

app.use(cors());
app.use(express.json({ limit: '15mb' })); // افزایش محدودیت حجم برای base64 عکس

// لاگ همه درخواست‌ها
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body);
  next();
});

app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

app.get('/test', (req, res) => {
  res.json({ message: 'server is running' });
});

// --- endpoint دریافت همه منابع ---
app.get('/sources', async (req, res) => {
  try {
    const sources = await sourcesCollection.find({}).toArray();
    res.json(sources);
  } catch (err) {
    console.error('❌ خطا در دریافت منابع:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

// --- endpoint جستجو در منابع ---
app.post('/search-sources', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ message: '❌ متن جستجو ارسال نشده است.' });

  try {
    const results = await sourcesCollection.find({
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { chunk: { $regex: query, $options: 'i' } },
        { tags: { $elemMatch: { $regex: query, $options: 'i' } } }
      ]
    }).toArray();

    res.json(results);
  } catch (err) {
    console.error('❌ خطا در جستجوی منابع:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});
// --- پایان endpoint جستجو ---

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
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    res.json({ answer: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error('❌ OpenAI Error:', err.response?.data || err.message);
    res.status(500).json({ message: '❌ خطا در پردازش سؤال', error: err.message });
  }
});

// ==== روت حرفه‌ای برای سوال تصویری (GPT-4o Vision + سرچ منابع) ====
app.post('/ask-question-image', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: '❌ تصویر ارسال نشده است.' });
  }

  try {
    // مرحله اول: OCR با ChatGPT Vision
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `
تصویر را بررسی کن و فقط متن دقیق سؤال و گزینه‌ها را (بدون توضیح اضافه) استخراج کن. اگر تستی نیست فقط همان سؤال را بنویس. هیچ توضیح اضافه‌ای ننویس. خروجی فقط باید متن OCR باشد.
`
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
              }
            ]
          }
        ],
        max_tokens: 1200
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    const ocrText = response.data.choices?.[0]?.message?.content?.trim() || '';

    // مرحله دوم: جستجو در منابع با متن OCR شده
    let searchResults = [];
    if (ocrText.length > 4) {
      searchResults = await sourcesCollection.find({
        $or: [
          { title: { $regex: ocrText, $options: 'i' } },
          { chunk: { $regex: ocrText, $options: 'i' } },
          { tags: { $elemMatch: { $regex: ocrText, $options: 'i' } } }
        ]
      }).toArray();
    }

    // خروجی ترکیبی: متن OCR و نتیجه منابع داخلی
    res.json({
      ocrText,
      sources: searchResults
    });
  } catch (err) {
    console.error('❌ OpenAI Vision Error:', err.response?.data || err.message);
    res.status(500).json({ message: '❌ خطا در پردازش تصویر یا ارتباط با OpenAI', error: err.message });
  }
});
// ==== پایان روت حرفه‌ای سوال تصویری ====

// --- Endpoint جدید: جواب فقط بر اساس منابع دیتابیس ---
app.post('/answer-from-sources', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ message: '❌ سوال ارسال نشده است.' });

  // جستجو در منابع
  let results = [];
  try {
    results = await sourcesCollection.find({
      $or: [
        { title: { $regex: question, $options: 'i' } },
        { chunk: { $regex: question, $options: 'i' } },
        { tags: { $elemMatch: { $regex: question, $options: 'i' } } }
      ]
    }).toArray();
  } catch (err) {
    return res.status(500).json({ message: '❌ خطا در جستجوی منابع', error: err.message });
  }

  // ساخت متن منابع
  const sourcesText = results.map(item => item.chunk).join('\n---\n').slice(0, 3500);
  const prompt = `فقط با توجه به منابع زیر به این سوال جواب بده. اگر پاسخ کامل در منابع نبود، بنویس "در منابع موجود نیست".
منابع:
${sourcesText}
سوال: ${question}
`;

  // ارسال به ChatGPT
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'تو یک معلم راهنما هستی.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    res.json({ answer: response.data.choices[0].message.content.trim(), sources: results });
  } catch (err) {
    res.status(500).json({ message: '❌ خطا در ChatGPT', error: err.message });
  }
});

// ادامه روال‌های قبلی
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

app.post('/submit-user-info', async (req, res) => {
  const { phoneNumber, name, lastName, age, gender, field } = req.body;

  if (!phoneNumber || !name || !lastName || !age || !gender || !field) {
    return res.status(400).json({ message: '❌ همه فیلدها باید پر شوند' });
  }

  try {
    await usersCollection.updateOne(
      { phoneNumber },
      {
        $set: {
          name,
          lastName,
          age,
          gender,
          field,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ message: '✅ اطلاعات کاربر ثبت شد' });
  } catch (err) {
    console.error('❌ خطا در ثبت اطلاعات کاربر:', err.message);
    res.status(500).json({ message: '❌ خطا در سرور', error: err.message });
  }
});

// لاگ شروع برنامه
console.log('Starting server...');

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
});
