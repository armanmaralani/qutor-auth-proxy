const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const querystring = require('querystring');

// ----------- تنظیمات پیامک OTP -----------
const SMS_API_KEY = "271090-ed383e0b114648a7917edecc61e73432";
const SMS_HOST = 'http://api.sms-webservice.com/api/V3/';
const SENDER = "3000XXXXXXX"; // شماره خدماتی خود را اینجا قرار بده

function performRequest(endpoint, method, data) {
  if (method == 'GET') {
    endpoint += '?' + querystring.stringify(data);
    data = null;
  }
  return axios({
    method: method,
    url: SMS_HOST + endpoint,
    data: data
  });
}

function SendSMS(Text, Sender, recipients) {
  return performRequest('Send', 'GET', {
    ApiKey: SMS_API_KEY,
    Text: Text,
    Sender: Sender,
    Recipients: recipients
  });
}

// ---------- ذخیره OTP موقت (ساده؛ برای تولید عملی، Redis پیشنهاد میشه) ----------
const otpCache = {};

// ----------- راه‌اندازی MongoDB ----------
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

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body ? Object.keys(req.body) : 'no body');
  next();
});

app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

// ----------- ROUTE: ارسال کد OTP پیامکی -----------
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "شماره موبایل الزامی است" });

  // ساخت کد OTP تصادفی ۵ رقمی
  const otp = Math.floor(10000 + Math.random() * 90000).toString();

  try {
    const text = `کد تایید شما: ${otp}`;
    await SendSMS(text, SENDER, phone);

    // ذخیره کد در حافظه موقت (۳ دقیقه)
    otpCache[phone] = { otp, expires: Date.now() + 3 * 60 * 1000 };

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "ارسال پیامک ناموفق بود", detail: e.message });
  }
});

// ----------- ROUTE: تایید کد OTP -----------
app.post('/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: "ورودی نامعتبر است" });

  const record = otpCache[phone];
  if (!record || record.otp !== otp || record.expires < Date.now()) {
    return res.status(400).json({ error: "کد تایید اشتباه یا منقضی شده" });
  }

  // ورود موفق
  delete otpCache[phone];
  res.json({ success: true, message: "ورود موفق!" });
});

// ----------- ROUTE: OCR & RAG by IMAGE (همانند قبل) -----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ کلید OpenAI در محیط تنظیم نشده');
  process.exit(1);
}

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

// شروع سرور و نمایش فقط لاگ ساده (بدون app._router.stack)
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
  // اگر خواستی لاگ endpointها، از این کد استفاده کن (خطا ندهد):
  try {
    if (app._router && app._router.stack) {
      app._router.stack
        .filter(r => r.route)
        .forEach(r => {
          const methods = Object.keys(r.route.methods).join(', ').toUpperCase();
          console.log(` - ${methods} ${r.route.path}`);
        });
    }
  } catch (err) {
    console.log('⚠️ Unable to print available endpoints:', err.message);
  }
});
