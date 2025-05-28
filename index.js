// index.js
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

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${port}`);
});
