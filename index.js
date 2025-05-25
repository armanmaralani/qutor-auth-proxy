const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const axios = require('axios');

console.log("Starting server...");

process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ کلید OpenAI در محیط تنظیم نشده');
  process.exit(1);
}

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

const uri = 'mongodb+srv://qutor:armanMaralani@cluster0.3wz5uni.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri, { useUnifiedTopology: true });
let usersCollection, sourcesCollection;

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

const whitelist = ['+989123456789', '+989365898911'];

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body ? Object.keys(req.body) : 'no body');
  next();
});

app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

// === ROUTE: OCR & RAG by IMAGE ===
app.post('/ask-question-image', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '❌ تصویر ارسال نشده است.' });

  try {
    // === مرحله ۱: OCR با GPT-4o ===
    const ocrResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'فقط متن دقیق سؤال و گزینه‌ها را از تصویر استخراج کن (بدون هیچ توضیح اضافه، فقط خود متن سؤال و گزینه‌ها).'
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            }
          ]
        }],
        max_tokens: 700
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    const ocrText = ocrResponse.data.choices?.[0]?.message?.content?.trim() || '';
    console.log('[OCR] متن استخراج‌شده:', ocrText);

    if (!ocrText || ocrText.length < 4) {
      return res.json({
        answer: '',
        ocrText,
        sources: [],
        message: '❌ متن معناداری استخراج نشد.',
      });
    }

    // === مرحله ۲: جستجو در دیتابیس و انتخاب ۱۰ منبع مرتبط ===
    const searchResults = await sourcesCollection.find({
      $or: [
        { title: { $regex: ocrText, $options: 'i' } },
        { chunk: { $regex: ocrText, $options: 'i' } },
        { tags: { $elemMatch: { $regex: ocrText, $options: 'i' } } }
      ]
    }).limit(10).toArray();

    let contextText = '';
    if (searchResults.length > 0) {
      contextText = searchResults
        .map((item, idx) => `[منبع ${idx + 1}]:\n${item.chunk}`)
        .join('\n\n');
    }

    // === مرحله ۳: ارسال سؤال و منابع به GPT-4o برای پاسخ نهایی ===
    let finalAnswer = '';
    if (contextText) {
      const qaResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'شما یک معلم خبره هستید. فقط با توجه به منابع زیر، به سوال کاربر پاسخ بده و هیچ اطلاعات خارج از منابع اضافه نکن.'
            },
            {
              role: 'user',
              content: `سوال:\n${ocrText}\n\nمنابع:\n${contextText}\n\nپاسخ گام‌به‌گام و علمی بده.`
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
      finalAnswer = qaResponse.data.choices?.[0]?.message?.content?.trim() || '';
    } else {
      finalAnswer = '❌ منبعی مرتبط با این سؤال در پایگاه داده یافت نشد.';
    }

    return res.json({
      answer: finalAnswer,
      ocrText,
      sources: searchResults
    });

  } catch (err) {
    let errMsg = err?.response?.data || err.message;
    console.error('❌ خطا در پردازش:', errMsg);
    res.status(500).json({
      answer: '',
      ocrText: '',
      sources: [],
      message: '❌ خطا در پردازش تصویر یا ارتباط با OpenAI',
      error: errMsg
    });
  }
});

// سایر route ها و endpoint ها همانند قبل

// ----- سایر endpoint هایت مثل /chat، /send-otp، /answer-from-sources و ... همینجوری بمونه -----

// شروع سرور و نمایش همه route ها برای اطمینان
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
  console.log('Available endpoints:');
  app._router.stack
    .filter(r => r.route)
    .forEach(r => console.log(` - ${Object.keys(r.route.methods).join(', ').toUpperCase()} ${r.route.path}`));
});
