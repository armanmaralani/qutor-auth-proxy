const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const querystring = require('querystring');

const SMS_API_KEY = "271090-2AFCEBCC206840D1A39DF074DCE09BBC";
const TEMPLATE_KEY = "Qutor";
const SMS_HOST = 'https://api.sms-webservice.com/api/V3/';

function performRequest(endpoint, method, data) {
  if (method === 'GET') {
    endpoint += '?' + querystring.stringify(data);
    data = null;
  }
  return axios({
    method,
    url: SMS_HOST + endpoint,
    headers: { 'Content-Type': 'text/plain' },
    data
  });
}

function sendOTPPatternSMS(destination, otp) {
  return performRequest('SendTokenSingle', 'GET', {
    ApiKey: SMS_API_KEY,
    TemplateKey: TEMPLATE_KEY,
    Destination: destination,
    p1: otp
  });
}

const otpCache = {};

const uri = 'mongodb+srv://qutor:armanMaralani@cluster0.3wz5uni.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const client = new MongoClient(uri, { useUnifiedTopology: true });

let usersCollection, sourcesCollection;

async function connectToMongo() {
  try {
    await client.connect();
    usersCollection = client.db('qutor-app').collection('users');
    sourcesCollection = client.db('qutor-app').collection('sources');
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB Error:', err.message);
    process.exit(1);
  }
}
connectToMongo();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Log requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body keys:`, req.body ? Object.keys(req.body) : 'no body');
  next();
});

app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "شماره موبایل الزامی است" });

  const otp = Math.floor(10000 + Math.random() * 90000).toString();

  try {
    await sendOTPPatternSMS(phone, otp);
    otpCache[phone] = { otp, expires: Date.now() + 3 * 60 * 1000 };
    res.json({ success: true });
  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ error: "ارسال پیامک ناموفق بود", detail: e.message, response: e.response?.data });
  }
});

app.post('/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: "ورودی نامعتبر است" });

  const record = otpCache[phone];
  if (!record || record.otp !== otp || record.expires < Date.now()) {
    return res.status(400).json({ error: "کد تایید اشتباه یا منقضی شده" });
  }

  delete otpCache[phone];
  res.json({ success: true, message: "ورود موفق!" });
});

app.post('/check-user-info', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "شماره موبایل الزامی است" });

  try {
    const user = await usersCollection.findOne({ phoneNumber });
    res.json({ exists: !!user });
  } catch (e) {
    console.error("خطا در بررسی اطلاعات کاربر:", e);
    res.status(500).json({ error: "خطا در سرور" });
  }
});

app.post('/submit-user-info', async (req, res) => {
  const { phoneNumber, name, lastName, age, gender, field } = req.body;

  if (!phoneNumber || !name || !lastName || !age || !gender || !field) {
    return res.status(400).json({ message: "تمام فیلدها باید پر شوند." });
  }

  try {
    const existingUser = await usersCollection.findOne({ phoneNumber });
    if (existingUser) {
      return res.status(400).json({ message: "کاربر قبلاً ثبت شده است." });
    }

    await usersCollection.insertOne({
      phoneNumber,
      name,
      lastName,
      age: parseInt(age, 10),
      gender,
      field,
      createdAt: new Date(),
    });

    res.json({ success: true, message: "اطلاعات با موفقیت ثبت شد." });
  } catch (e) {
    console.error("خطا در ثبت اطلاعات کاربر:", e);
    res.status(500).json({ message: "خطا در ثبت اطلاعات کاربر" });
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ OpenAI API key not set in environment');
  process.exit(1);
}

// ============ اصلاح اصلی اینجاست ==============
app.post('/ask-question-image', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '❌ تصویر ارسال نشده است.' });

  try {
    // تغییر اصلی: ارسال مستقیم base64 به OCR با application/json
    console.log('[OCR] Sending image to OCR service...');
    const ocrResponse = await axios.post(
      'https://ocr-flask.liara.run/ocr',
      { imageBase64 },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const ocrText = ocrResponse.data.text?.trim() || '';
    console.log('[OCR] Extracted text:', ocrText);

    if (!ocrText || ocrText.length < 4) {
      return res.json({
        answer: '',
        ocrText,
        sources: [],
        message: '❌ متن معناداری استخراج نشد.',
      });
    }

    // Search database
    let searchResults = [];
    if (ocrText.length > 4) {
      const keywords = ocrText.replace(/[۰-۹0-9\(\)\/\\\:\?\.\,\،\؛\:\-\"\']/g, '').split(/\s+/).filter(w => w.length > 2);
      console.log('[DB] Search keywords:', keywords);
      if (keywords.length > 0) {
        searchResults = await sourcesCollection.find({
          $or: keywords.map(word => ({
            $or: [
              { title: { $regex: word, $options: 'i' } },
              { chunk: { $regex: word, $options: 'i' } },
              { tags: { $elemMatch: { $regex: word, $options: 'i' } } }
            ]
          }))
        }).limit(10).toArray();
      }
      console.log('[DB] Results found:', searchResults.length);
    }

    let contextText = '';
    if (searchResults.length > 0) {
      contextText = searchResults.map((item, idx) => `[منبع ${idx + 1}]:\n${item.chunk}`).join('\n\n');
    }

    // Call OpenAI GPT-3.5-Turbo with context
    let finalAnswer = '';
    if (contextText) {
      console.log('[OpenAI] Sending question to OpenAI...');
      const qaResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'شما یک معلم خبره هستید. فقط با توجه به منابع زیر، به سوال کاربر پاسخ بده و هیچ اطلاعات خارج از منابع اضافه نکن.' },
            { role: 'user', content: `سوال:\n${ocrText}\n\nمنابع:\n${contextText}\n\nپاسخ گام‌به‌گام و علمی بده.` }
          ],
          max_tokens: 1200
        },
        {
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
        }
      );
      finalAnswer = qaResponse.data.choices?.[0]?.message?.content?.trim() || '';
      console.log('[OpenAI] Received answer:', finalAnswer);
    } else {
      finalAnswer = '❌ منبعی مرتبط با این سؤال در پایگاه داده یافت نشد.';
      console.log('[OpenAI] No sources found.');
    }

    return res.json({
      answer: finalAnswer,
      ocrText,
      sources: searchResults
    });

  } catch (err) {
    let errMsg = err?.response?.data || err.message;
    console.error('❌ Processing error:', errMsg);
    res.status(500).json({
      answer: '',
      ocrText: '',
      sources: [],
      message: '❌ خطا در پردازش تصویر یا ارتباط با OpenAI',
      error: errMsg
    });
  }
});
// ============ پایان اصلاح اصلی ==============

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
});
