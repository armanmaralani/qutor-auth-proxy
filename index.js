const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const querystring = require('querystring');

// تنظیمات پیامک OTP با الگوی SendTokenSingle
const SMS_API_KEY = "271090-2AFCEBCC206840D1A39DF074DCE09BBC";
const TEMPLATE_KEY = "Qutor"; // بدون فاصله و دقیقاً همان‌طور که در پنل تعریف شده
const SMS_HOST = 'https://api.sms-webservice.com/api/V3/';

function performRequest(endpoint, method, data) {
  if (method === 'GET') {
    endpoint += '?' + querystring.stringify(data);
    data = null;
  }
  return axios({
    method: method,
    url: SMS_HOST + endpoint,
    headers: { 'Content-Type': 'text/plain' },
    data: data
  });
}

function sendOTPPatternSMS(destination, otp) {
  // شماره موبایل را دقیقاً با فرمت 09 یا 989 ارسال کن
  return performRequest('SendTokenSingle', 'GET', {
    ApiKey: SMS_API_KEY,
    TemplateKey: TEMPLATE_KEY,
    Destination: destination,
    p1: otp
  });
}

// ذخیره OTP موقت در حافظه (۳ دقیقه)
const otpCache = {};

// اتصال به MongoDB
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

// لاگ درخواست‌ها
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body ? Object.keys(req.body) : 'no body');
  next();
});

// تست اتصال ساده
app.get('/', (req, res) => {
  res.send('✅ Qutor API is running.');
});

// روت ارسال OTP
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

// روت تایید OTP
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

// روت بررسی وجود اطلاعات کاربر
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

// روت ثبت اطلاعات کاربر
app.post('/submit-user-info', async (req, res) => {
  const { phoneNumber, name, lastName, age, gender, field } = req.body;

  if (!phoneNumber || !name || !lastName || !age || !gender || !field) {
    return res.status(400).json({ message: "تمام فیلدها باید پر شوند." });
  }

  try {
    // بررسی وجود کاربر
    const existingUser = await usersCollection.findOne({ phoneNumber });
    if (existingUser) {
      return res.status(400).json({ message: "کاربر قبلاً ثبت شده است." });
    }

    // درج کاربر جدید
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

// روت استخراج متن از تصویر و پاسخ با OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ کلید OpenAI در محیط تنظیم نشده');
  process.exit(1);
}

app.post('/ask-question-image', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '❌ تصویر ارسال نشده است.' });

  try {
    // مرحله ۱: OCR با مدل gpt-3.5-turbo
    const ocrResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'فقط متن دقیق سؤال و گزینه‌ها را از تصویر استخراج کن (بدون هیچ توضیح اضافه، فقط خود متن سؤال و گزینه‌ها).' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
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

    // مرحله ۲: جستجوی پیشرفته با کلمات کلیدی
    let searchResults = [];
    if (ocrText.length > 4) {
      const keywords = ocrText.replace(/[۰-۹0-9\(\)\/\\\:\?\.\,\،\؛\:\-\"\']/g, '').split(/\s+/).filter(w => w.length > 2);
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
    }

    let contextText = '';
    if (searchResults.length > 0) {
      contextText = searchResults.map((item, idx) => `[منبع ${idx + 1}]:\n${item.chunk}`).join('\n\n');
    }

    // مرحله ۳: پاسخ نهایی با مدل gpt-3.5-turbo
    let finalAnswer = '';
    if (contextText) {
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

// اجرای سرور
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
});
