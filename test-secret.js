const fs = require('fs');

try {
  // تلاش برای خواندن فایل سکرت از مسیر /etc/secrets/firebase-key.json
  const data = fs.readFileSync('/etc/secrets/firebase-key.json', 'utf8');
  console.log('✅ محتویات فایل firebase-key.json:');
  console.log(data);
} catch (err) {
  console.error('❌ خطا در خواندن فایل firebase-key.json');
  console.error(err.message);
}
