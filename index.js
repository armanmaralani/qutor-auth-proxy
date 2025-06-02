// 📁 فایل کامل سرور با جستجوی embedding حرفه‌ای و پرامپت معلمی سفت برای /rag-answer
require('dotenv').config();
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
  return axios({ method, url: SMS_HOST + endpoint, headers: { 'Content-Type': 'text/plain' }, data });
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

const uri = 'mongodb://root:rAFPwnjnIKzWCibfMH6mWpC6@qutor-database:27017/my-app?authSource=admin&replicaSet=rs0&directConnection=true';
const client = new MongoClient(uri, { useUnifiedTopology: true });

let usersCollection, sourcesCollection;

async function connectToMongo() {
  try {
    await client.connect();
    usersCollection = client.db('qutor-database').collection('users');
    sourcesCollection = client.db('qutor-database').collection('sources');
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

app.get('/', (req, res) => res.send('✅ Qutor API is running.'));

app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "شماره موبایل الزامی است" });
  const otp = Math.floor(10000 + Math.random() * 90000).toString();
  try {
    await sendOTPPatternSMS(phone, otp);
    otpCache[phone] = { otp, expires: Date.now() + 180000 };
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "ارسال پیامک ناموفق بود", detail: e.message });
  }
});

app.post('/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const record = otpCache[phone];
  if (!record || record.otp !== otp || record.expires < Date.now()) return res.status(400).json({ error: "کد تایید اشتباه یا منقضی شده" });
  delete otpCache[phone];
  res.json({ success: true });
});

app.post('/check-user-info', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const user = await usersCollection.findOne({ phoneNumber });
    res.json({ exists: !!user });
  } catch (e) {
    res.status(500).json({ error: "خطا در سرور" });
  }
});

app.post('/submit-user-info', async (req, res) => {
  const { phoneNumber, name, lastName, age, gender, field } = req.body;
  if (!phoneNumber || !name || !lastName || !age || !gender || !field) return res.status(400).json({ message: "تمام فیلدها باید پر شوند." });
  try {
    const existing = await usersCollection.findOne({ phoneNumber });
    if (existing) return res.status(400).json({ message: "کاربر قبلاً ثبت شده است." });
    await usersCollection.insertOne({ phoneNumber, name, lastName, age: +age, gender, field, createdAt: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: "خطا در ثبت اطلاعات کاربر" });
  }
});

// --- /rag-answer با رفتار سفت و معلمی واقعی ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
});

app.post('/rag-answer', async (req, res) => {
  const { imageUrl } = req.body;
  const liaraApiKey = process.env.LIARA_API_KEY;
  const geminiApiUrl = 'https://ai.liara.ir/api/v1/6836ffd10a2dc9a15179b645/chat/completions';

  try {
    // ۱. استخراج متن سؤال از تصویر
    const visionPrompt = "فقط متن سؤال کامل موجود در این تصویر را دقیق و بدون توضیح اضافه استخراج کن.";
    const visionRes = await axios.post(geminiApiUrl, {
      model: "openai/gpt-4.1",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: visionPrompt },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }]
    }, { headers: { Authorization: `Bearer ${liaraApiKey}` } });

    const questionText = visionRes.data.choices[0].message.content.trim();
    if (!questionText) {
      return res.json({
        answer: "متن سؤال قابل استخراج نبود. لطفاً عکس واضح‌تر و دقیق‌تری ارسال کنید.",
        extractedQuestion: null,
        relatedDocs: []
      });
    }

    // ۲. استخراج embedding و جستجو در دیتابیس
    const embeddingRes = await openai.post('/embeddings', {
      input: questionText,
      model: 'text-embedding-ada-002'
    });
    const queryVector = embeddingRes.data.data[0].embedding;

    const similarDocs = await sourcesCollection.aggregate([
      {
        $vectorSearch: {
          index: 'embedding-index',
          path: 'embedding',
          queryVector,
          numCandidates: 100,
          limit: 5
        }
      }
    ]).toArray();

    let answer = "";

    // پرامپت سفت برای معلمی واقعی
    function getTeacherPrompt({questionText, infoString, hasDbDocs}) {
      if (hasDbDocs) {
        return `
تو نقش یک معلم حرفه‌ای و باحوصله هستی. باید جواب این سؤال را کاملاً گام‌به‌گام و آموزش‌محور توضیح بدهی.
اجازه نداری هیچ اشاره‌ای به منبع، فایل، دیتابیس، جدول یا فصل کتاب بکنی.
همه نکات را با زبان خودت و برای یادگیری بهتر دانش‌آموز توضیح بده.
اگر لازم است داده‌ای (مانند مقدار یا عدد) بنویسی، مستقیم بنویس و نگو "طبق جدول" یا "طبق فصل".
تمام توضیحات باید به‌صورت مرحله به مرحله و آموزشی باشد. فقط توضیح بده، فقط آموزش بده.
----------------
صورت سؤال:
${questionText}

اطلاعات آموزشی (فقط برای خودت، نه برای ذکر در جواب):
${infoString}
`;
      } else {
        return `
تو نقش یک معلم متوسط و استاد کنکور ایرانی هستی. باید به این سؤال با زبان ساده، آموزش گام‌به‌گام و بدون هیچ ارجاعی به منبع یا کتاب یا جدول جواب بدهی. فرض کن دانش‌آموزت سر کلاس نشسته و فقط توضیح تو را می‌شنود. همه مفاهیم را توضیح بده، داده‌ها را مستقیم بنویس و هیچ‌وقت به فصل، جدول یا منبع اشاره نکن.
----------------
صورت سؤال:
${questionText}
`;
      }
    }

    if (similarDocs.length > 0) {
      // اگر دیتابیس جواب داشت: معلمی، گام به گام، بدون ارجاع به دیتابیس
      const infoString = similarDocs.map(d => `- ${d.question}\n  پاسخ: ${d.answer}`).join('\n');
      const finalPrompt = getTeacherPrompt({
        questionText,
        infoString,
        hasDbDocs: true,
      });

      const answerRes = await axios.post(geminiApiUrl, {
        model: "openai/gpt-4.1",
        messages: [
          { role: "system", content: "تو یک معلم حرفه‌ای و باحوصله هستی که آموزش گام به گام و بدون هیچ ارجاع به منبع می‌دهی." },
          { role: "user", content: finalPrompt }
        ]
      }, { headers: { Authorization: `Bearer ${liaraApiKey}` } });

      answer = answerRes.data.choices[0].message.content.trim();
      if (!answer || answer.length < 10) {
        answer = "با توجه به پیچیدگی این سؤال، بهتر است آن را با معلم خود هماهنگ کنید تا راه حل را دقیق‌تر آموزش ببینید.";
      }
    } else {
      // اگر دیتابیس جواب نداشت: معلم کنکوری ایرانی و آموزش کامل، باز بدون هیچ ارجاع
      const finalPrompt = getTeacherPrompt({
        questionText,
        infoString: "",
        hasDbDocs: false,
      });

      const answerRes = await axios.post(geminiApiUrl, {
        model: "openai/gpt-4.1",
        messages: [
          { role: "system", content: "تو یک معلم مقطع متوسطه اول و دوم و استاد کنکور ایرانی هستی که فقط آموزش گام به گام و بدون هیچ ارجاعی به منبع یا جدول می‌دهی." },
          { role: "user", content: finalPrompt }
        ]
      }, { headers: { Authorization: `Bearer ${liaraApiKey}` } });

      answer = answerRes.data.choices[0].message.content.trim();
      if (!answer || answer.length < 10) {
        answer = "با توجه به پیچیدگی این سؤال، بهتر است آن را با معلم خود هماهنگ کنید تا راه حل را دقیق‌تر آموزش ببینید.";
      }
    }

    res.json({
      answer,
      extractedQuestion: questionText,
      relatedDocs: similarDocs
    });

  } catch (err) {
    console.error("❌ /rag-answer error:", err.response?.data || err.message);
    if (err.response?.status === 400 || err.response?.status === 500) {
      return res.json({
        answer: "با توجه به پیچیدگی این سؤال، بهتر است آن را با معلم خود هماهنگ کنید تا راه حل را دقیق‌تر آموزش ببینید.",
        extractedQuestion: null,
        relatedDocs: []
      });
    }
    res.status(500).json({ error: "خطای سرور" });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Qutor API on port ${port}`));
